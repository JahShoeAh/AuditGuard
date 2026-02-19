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
const { Indexer, Batcher, KvClient, StorageNode } = require("@0gfoundation/0g-ts-sdk");
const { ethers } = require("ethers");

const DATA_DIR = path.join(__dirname, "..", "data");
const LOCAL_STORE_PATH = path.join(DATA_DIR, "inft-state.json");
const INDEX_PATH = path.join(DATA_DIR, "inft-index.json");

// 0g testnet endpoints
const DEFAULT_ZG_EVM_RPC = "https://evmrpc-testnet.0g.ai";
const DEFAULT_ZG_INDEXER_RPC = "https://indexer-storage-testnet-turbo.0g.ai";
const DEFAULT_ZG_KV_RPC = "http://3.101.147.150:6789";

// Known 0g Testnet Contract Addresses (Bypasses SDK discovery bugs)
const ZG_FLOW_CONTRACT_ADDRESS = "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296";

// Stream ID for AuditGuard iNFT KV namespace (unique hash to avoid collisions)
const AUDITGUARD_STREAM_ID = ethers.keccak256(ethers.toUtf8Bytes("AuditGuard-iNFT-v2"));

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
    this._zgDisabledManually = false;
    this._isWriting = false; // Mutex flag for serialization

    // 0g SDK objects (initialized lazily)
    this._indexer = null;
    this._signer = null;
    this._kvClient = null;

    // Failure counter to prevent repeated crashes from buggy SDK
    this._failureCount = 0;
    this._maxFailures = 3;

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
    if (this._zgDisabledManually) return false;
    if (this._zgInitialized) return this._zgAvailable;
    this._zgInitialized = true;

    if (!this.zgPrivateKey) {
      console.log("  [storage] No ZG_PRIVATE_KEY configured — using local fallback only");
      return false;
    }

    try {
      const provider = new ethers.JsonRpcProvider(this.zgEvmRpc);
      
      // Patch provider to strictly disable ENS resolution
      provider.resolveName = async () => null;
      provider.getEnsAddress = async () => null;

      // Global safety: Catch unhandled rejections from buggy SDK event listeners
      process.on("unhandledRejection", (reason) => {
        const msg = reason?.message || String(reason);
        if (msg.includes("ENS") || msg.includes("UNCONFIGURED_NAME")) {
          this._handleZgFailure(`Caught unhandled ENS error from SDK: ${msg}`);
        }
      });

      this._signer = new ethers.Wallet(this.zgPrivateKey, provider);
      console.log(`  [storage] 0g Signer Address: ${this._signer.address}`);
      this._indexer = new Indexer(this.zgIndexerRpc);
      this._kvClient = new KvClient(this.zgKvRpc);
      
      this._zgAvailable = true;
      return true;
    } catch (err) {
      console.warn(`  [storage] 0g Labs initialization failed: ${err.message} — using local fallback`);
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
    if (!this._zgDisabledManually) {
      await this._initZg();
      if (this._zgAvailable) {
        try {
          await this._zgKvSet(key, jsonData);
          console.log(`  [storage] Saved to 0g: ${key}`);
        } catch (err) {
          this._handleZgFailure(`0g write failed for ${key}: ${err.message}`);
        }
      }
    }
  }

  _handleZgFailure(msg) {
    this._failureCount++;
    console.warn(`  [storage] ${msg} (failure ${this._failureCount}/${this._maxFailures})`);
    if (this._failureCount >= this._maxFailures) {
      console.warn("  [storage] 0g Labs integration disabled for this session due to repeated SDK errors.");
      this._zgAvailable = false;
      this._zgDisabledManually = true;
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
    if (!this._zgDisabledManually) {
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
          this._handleZgFailure(`0g read failed for ${key}: ${err.message}`);
        }
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
    if (!this._zgDisabledManually) {
      await this._initZg();
    }
    
    if (!this._zgAvailable || this._zgDisabledManually) {
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
      const { ZgFile } = require("@0gfoundation/0g-ts-sdk");

      // Write data to a temp file for ZgFile
      const tmpPath = path.join(DATA_DIR, `.tmp-blob-${Date.now()}`);
      fs.writeFileSync(tmpPath, typeof data === "string" ? data : data);

      const file = await ZgFile.fromFilePath(tmpPath);
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

      const rootHash = tree.rootHash();

      // Attempt upload with SDK discovery ( Galileo )
      try {
        console.log(`  [storage] Attempting 0g upload for "${label}"...`);
        const [tx, uploadErr] = await this._indexer.upload(file, this.zgEvmRpc, this._signer);
        await file.close();
        if (uploadErr) throw uploadErr;
        console.log(`  [storage] Blob "${label}" uploaded to 0g — root: ${rootHash}`);
      } catch (sdkErr) {
        this._handleZgFailure(`0g upload failed: ${sdkErr.message}`);
      }

      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch {}

      return rootHash;
    } catch (err) {
      this._handleZgFailure(`0g blob process failed for "${label}": ${err.message}`);
      return ethers.keccak256(typeof data === "string" ? ethers.toUtf8Bytes(data) : data);
    }
  }

  /**
   * Download a blob from 0g by root hash.
   *
   * @param {string} rootHash
   * @returns {Promise<Buffer|null>}
   */
  async downloadBlob(rootHash) {
    if (!this._zgDisabledManually) {
      await this._initZg();
    }
    
    if (!this._zgAvailable || this._zgDisabledManually) {
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
      this._handleZgFailure(`0g download failed for ${rootHash}: ${err.message}`);
      return null;
    }
  }

  // ─── 0g KV Operations ─────────────────────────────────────────────────────

  // Mutex to prevent "replacement transaction underpriced" errors from concurrent writes
  async _zgKvSet(key, value) {
    // Wait for the previous write to complete
    while (this._isWriting) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this._isWriting = true;

    try {
      const [nodes, nodesErr] = await this._indexer.selectNodes(1);
      if (nodesErr) throw new Error(`Node selection failed: ${nodesErr}`);

      // Try automatic discovery first
      const flowContract = await getFlowContractSafe(ZG_FLOW_CONTRACT_ADDRESS, this._signer);
      const batcher = new Batcher(1, nodes, flowContract, this.zgEvmRpc);
      const keyBytes = Uint8Array.from(Buffer.from(key, "utf-8"));
      const valBytes = Uint8Array.from(Buffer.from(value, "utf-8"));
      batcher.streamDataBuilder.set(AUDITGUARD_STREAM_ID, keyBytes, valBytes);
      const [tx, err] = await batcher.exec();
      if (err) throw err;
      
      // Small cooling period after write to let nonce propagate
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      throw err;
    } finally {
      this._isWriting = false;
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
async function getFlowContractSafe(address, signer) {
  const { getFlowContract } = require("@0gfoundation/0g-ts-sdk");
  return await getFlowContract(address, signer);
}

module.exports = { StorageAdapter };
