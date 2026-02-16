/**
 * AuditGuard iNFT Storage Adapter — 0g Labs DA + Local Fallback
 *
 * Persists iNFT metadata using the 0g Labs KV store for decentralized
 * data availability. Falls back to a local JSON file when 0g is
 * unreachable so the demo never breaks.
 *
 * Storage key format: `${collectionKey}:${serialNumber}`
 * Storage value: JSON-serialized iNFT metadata object
 *
 * Also maintains a local index of all known iNFTs per collection
 * for enumeration (0g KV doesn't support prefix scans).
 */

const path = require("path");
const fs = require("fs");
const { Indexer, Batcher, KvClient } = require("@0glabs/0g-ts-sdk");
const { ethers } = require("ethers");

const DATA_DIR = path.join(__dirname, "..", "data");
const LOCAL_STORE_PATH = path.join(DATA_DIR, "inft-state.json");
const INDEX_PATH = path.join(DATA_DIR, "inft-index.json");

// 0g testnet endpoints
const DEFAULT_ZG_EVM_RPC = "https://evmrpc-testnet.0g.ai";
const DEFAULT_ZG_INDEXER_RPC = "https://indexer-storage-testnet-turbo.0g.ai";
const DEFAULT_ZG_KV_RPC = "http://3.101.147.150:6789";

// Stream ID for AuditGuard iNFT KV namespace
const STREAM_DOMAIN = "0x";
const AUDITGUARD_STREAM_ID = "0x0000000000000000000000000000000000000000000000000000000000000001";

class StorageAdapter {
  /**
   * @param {object} [options]
   * @param {string} [options.zgPrivateKey] - 0g testnet private key for writes
   * @param {string} [options.zgEvmRpc] - 0g EVM RPC endpoint
   * @param {string} [options.zgIndexerRpc] - 0g storage indexer endpoint
   * @param {string} [options.zgKvRpc] - 0g KV client endpoint
   */
  constructor(options = {}) {
    let key = options.zgPrivateKey || process.env.ZG_PRIVATE_KEY;
    if (key && !key.startsWith("0x")) {
      key = `0x${key}`;
    }
    this.zgPrivateKey = key;
    this.zgEvmRpc = options.zgEvmRpc || process.env.ZG_EVM_RPC || DEFAULT_ZG_EVM_RPC;
    this.zgIndexerRpc = options.zgIndexerRpc || process.env.ZG_INDEXER_RPC || DEFAULT_ZG_INDEXER_RPC;
    this.zgKvRpc = options.zgKvRpc || process.env.ZG_KV_RPC || DEFAULT_ZG_KV_RPC;

    // In-memory cache for fast reads
    this._cache = new Map();

    // Local index tracking which serials exist per collection
    this._index = this._loadIndex();

    // 0g availability flag
    this._zgAvailable = false;
    this._zgInitialized = false;

    // 0g SDK objects (initialized lazily)
    this._indexer = null;
    this._signer = null;
    this._kvClient = null;

    // Ensure local data directory exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Load local store into cache on startup
    this._loadLocalStore();
  }

  /**
   * Initialize 0g Labs connection. Called lazily on first write.
   * @returns {Promise<boolean>} Whether 0g is available
   */
  async _initZg() {
    if (this._zgInitialized) return this._zgAvailable;
    this._zgInitialized = true;

    if (!this.zgPrivateKey) {
      console.log("  [storage] No ZG_PRIVATE_KEY configured — using local fallback only");
      return false;
    }

    try {
      const provider = new ethers.JsonRpcProvider(this.zgEvmRpc);
      this._signer = new ethers.Wallet(this.zgPrivateKey, provider);
      this._indexer = new Indexer(this.zgIndexerRpc);
      this._kvClient = new KvClient(this.zgKvRpc);
      this._zgAvailable = true;
      console.log(`  [storage] 0g Labs connected (${this.zgEvmRpc})`);
      return true;
    } catch (err) {
      console.warn(`  [storage] 0g Labs unavailable: ${err.message} — using local fallback`);
      this._zgAvailable = false;
      return false;
    }
  }

  /**
   * Save iNFT metadata. Writes to 0g KV store + local file fallback.
   *
   * @param {string} collectionKey - "auditJob" | "agentProfile" | "contractHealth"
   * @param {number} serialNumber
   * @param {object} metadata - Full iNFT metadata object
   */
  async save(collectionKey, serialNumber, metadata) {
    const key = `${collectionKey}:${serialNumber}`;
    const jsonData = JSON.stringify(metadata);

    // Always update in-memory cache and local file
    this._cache.set(key, metadata);
    this._updateIndex(collectionKey, serialNumber);
    this._saveLocalStore();

    // Try 0g KV write
    await this._initZg();
    if (this._zgAvailable) {
      try {
        await this._zgKvSet(key, jsonData);
        console.log(`  [storage] Saved to 0g: ${key}`);
      } catch (err) {
        console.warn(`  [storage] 0g write failed for ${key}: ${err.message} (local fallback OK)`);
      }
    }
  }

  /**
   * Load iNFT metadata. Reads from cache first, then 0g, then local file.
   *
   * @param {string} collectionKey
   * @param {number} serialNumber
   * @returns {Promise<object|null>}
   */
  async load(collectionKey, serialNumber) {
    const key = `${collectionKey}:${serialNumber}`;

    // Check in-memory cache first
    if (this._cache.has(key)) {
      return this._cache.get(key);
    }

    // Try 0g KV read
    await this._initZg();
    if (this._zgAvailable) {
      try {
        const data = await this._zgKvGet(key);
        if (data) {
          const metadata = JSON.parse(data);
          this._cache.set(key, metadata);
          return metadata;
        }
      } catch (err) {
        console.warn(`  [storage] 0g read failed for ${key}: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * List all iNFTs of a given collection type.
   *
   * @param {string} collectionKey
   * @returns {object[]}
   */
  listAll(collectionKey) {
    const serials = this._index[collectionKey] || [];
    const results = [];
    for (const serial of serials) {
      const key = `${collectionKey}:${serial}`;
      const metadata = this._cache.get(key);
      if (metadata) {
        results.push(metadata);
      }
    }
    return results;
  }

  /**
   * Find an iNFT by a field value (e.g., find audit job by jobId).
   *
   * @param {string} collectionKey
   * @param {string} field - Dot-notation path (e.g., "jobId", "agentAddress")
   * @param {*} value - Value to match
   * @returns {object|null}
   */
  findBy(collectionKey, field, value) {
    const all = this.listAll(collectionKey);
    return all.find((item) => this._getNestedField(item, field) === value) || null;
  }

  /**
   * Find an iNFT serial number by a field value.
   *
   * @param {string} collectionKey
   * @param {string} field
   * @param {*} value
   * @returns {number|null}
   */
  findSerialBy(collectionKey, field, value) {
    const serials = this._index[collectionKey] || [];
    for (const serial of serials) {
      const key = `${collectionKey}:${serial}`;
      const metadata = this._cache.get(key);
      if (metadata && this._getNestedField(metadata, field) === value) {
        return serial;
      }
    }
    return null;
  }

  /**
   * Upload a large data blob (audit report, detailed logs) to 0g file storage.
   * Returns the root hash for on-chain/iNFT reference.
   *
   * @param {Buffer|string} data - Data to store
   * @param {string} label - Human-readable label for logging
   * @returns {Promise<string|null>} Root hash (0g DA reference) or null if unavailable
   */
  async uploadBlob(data, label) {
    await this._initZg();
    if (!this._zgAvailable) {
      console.warn(`  [storage] 0g unavailable — cannot upload blob "${label}"`);
      // Save locally as fallback
      const blobDir = path.join(DATA_DIR, "blobs");
      fs.mkdirSync(blobDir, { recursive: true });
      const hash = ethers.keccak256(
        typeof data === "string" ? ethers.toUtf8Bytes(data) : data
      );
      const blobPath = path.join(blobDir, `${hash.slice(2, 18)}.json`);
      fs.writeFileSync(blobPath, typeof data === "string" ? data : data.toString("utf8"));
      console.log(`  [storage] Blob saved locally: ${blobPath}`);
      return hash;
    }

    try {
      const { ZgFile } = require("@0glabs/0g-ts-sdk");

      // Write data to a temp file for ZgFile
      const tmpPath = path.join(DATA_DIR, `.tmp-blob-${Date.now()}`);
      fs.writeFileSync(tmpPath, typeof data === "string" ? data : data);

      const file = await ZgFile.fromFilePath(tmpPath);
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

      const rootHash = tree.rootHash();

      const [tx, uploadErr] = await this._indexer.upload(file, this.zgEvmRpc, this._signer);
      await file.close();

      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch {}

      if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

      console.log(`  [storage] Blob "${label}" uploaded to 0g — root: ${rootHash}`);
      return rootHash;
    } catch (err) {
      console.warn(`  [storage] 0g blob upload failed for "${label}": ${err.message}`);
      return null;
    }
  }

  /**
   * Download a blob from 0g by root hash.
   *
   * @param {string} rootHash
   * @returns {Promise<Buffer|null>}
   */
  async downloadBlob(rootHash) {
    await this._initZg();
    if (!this._zgAvailable) {
      // Try local fallback
      const blobPath = path.join(DATA_DIR, "blobs", `${rootHash.slice(2, 18)}.json`);
      if (fs.existsSync(blobPath)) {
        return fs.readFileSync(blobPath);
      }
      return null;
    }

    try {
      const outPath = path.join(DATA_DIR, `.tmp-download-${Date.now()}`);
      const err = await this._indexer.download(rootHash, outPath, false);
      if (err) throw new Error(`Download error: ${err}`);

      const data = fs.readFileSync(outPath);
      try { fs.unlinkSync(outPath); } catch {}
      return data;
    } catch (err) {
      console.warn(`  [storage] 0g download failed for ${rootHash}: ${err.message}`);
      return null;
    }
  }

  // ─── 0g KV Operations ─────────────────────────────────────────────────────

  async _zgKvSet(key, value) {
    try {
      const [nodes, nodesErr] = await this._indexer.selectNodes(1);
      if (nodesErr) throw new Error(`Node selection failed: ${nodesErr}`);

      const flowContract = await getFlowContractSafe(this.zgEvmRpc, this._signer);
      const batcher = new Batcher(1, nodes, flowContract, this.zgEvmRpc);

      const keyBytes = Uint8Array.from(Buffer.from(key, "utf-8"));
      const valBytes = Uint8Array.from(Buffer.from(value, "utf-8"));

      batcher.streamDataBuilder.set(AUDITGUARD_STREAM_ID, keyBytes, valBytes);
      const [tx, err] = await batcher.exec();
      if (err) throw new Error(`KV set failed: ${err}`);
    } catch (err) {
      // Re-throw to be caught by the caller's try-catch
      throw err;
    }
  }

  async _zgKvGet(key) {
    if (!this._kvClient) return null;
    const keyBytes = Buffer.from(key, "utf-8");
    const keyBase64 = ethers.encodeBase64(keyBytes);
    try {
      const val = await this._kvClient.getValue(AUDITGUARD_STREAM_ID, keyBase64);
      if (!val) return null;
      return Buffer.from(val).toString("utf-8");
    } catch {
      return null;
    }
  }

  // ─── Local Persistence ────────────────────────────────────────────────────

  _loadLocalStore() {
    if (!fs.existsSync(LOCAL_STORE_PATH)) return;
    try {
      const data = JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, "utf8"));
      for (const [key, value] of Object.entries(data)) {
        this._cache.set(key, value);
      }
      console.log(`  [storage] Loaded ${Object.keys(data).length} iNFTs from local store`);
    } catch (err) {
      console.warn(`  [storage] Could not load local store: ${err.message}`);
    }
  }

  _saveLocalStore() {
    const data = {};
    for (const [key, value] of this._cache) {
      data[key] = value;
    }
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(data, null, 2));
  }

  _loadIndex() {
    if (!fs.existsSync(INDEX_PATH)) return {};
    try {
      return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    } catch {
      return {};
    }
  }

  _updateIndex(collectionKey, serialNumber) {
    if (!this._index[collectionKey]) {
      this._index[collectionKey] = [];
    }
    if (!this._index[collectionKey].includes(serialNumber)) {
      this._index[collectionKey].push(serialNumber);
      fs.writeFileSync(INDEX_PATH, JSON.stringify(this._index, null, 2));
    }
  }

  _getNestedField(obj, path) {
    return path.split(".").reduce((o, p) => (o ? o[p] : undefined), obj);
  }
}

/**
 * Safely get the 0g flow contract instance.
 */
async function getFlowContractSafe(evmRpc, signer) {
  const { getFlowContract } = require("@0glabs/0g-ts-sdk");
  return await getFlowContract(evmRpc, signer);
}

module.exports = { StorageAdapter };
