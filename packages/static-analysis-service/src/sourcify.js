"use strict";

/**
 * sourcify.js
 *
 * Attempts to download verified Solidity source files for a contract from the
 * Sourcify repository.  Returns the path to a temp directory containing the
 * .sol files on success, or null if the contract is unverified / unreachable.
 *
 * Hedera testnet chain ID: 296
 * Sourcify files endpoint: https://sourcify.dev/server/files/all/{chainId}/{address}
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const SOURCIFY_BASE = process.env.SOURCIFY_API_URL ?? "https://sourcify.dev/server";
const HEDERA_CHAIN_ID = process.env.HEDERA_CHAIN_ID ?? "296";

/**
 * Fetch JSON from a URL, returns the parsed body or null on any error.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<unknown|null>}
 */
function fetchJson(url, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        return resolve(null);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * Fetch verified Solidity sources for `contractAddress` from Sourcify.
 * Writes each .sol file into a fresh temp directory and returns its path.
 *
 * @param {string} contractAddress  EVM address (any casing)
 * @returns {Promise<string|null>}  Absolute path to temp dir, or null if not found
 */
async function fetchSourceFromSourcify(contractAddress) {
  const addr = contractAddress.toLowerCase();
  const url = `${SOURCIFY_BASE}/files/all/${HEDERA_CHAIN_ID}/${addr}`;

  let data;
  try {
    data = await fetchJson(url);
  } catch {
    return null;
  }

  if (!data || !Array.isArray(data.files) || data.files.length === 0) {
    return null;
  }

  // Only keep .sol files
  const solFiles = data.files.filter(
    (f) => typeof f.name === "string" && f.name.endsWith(".sol") && typeof f.content === "string"
  );
  if (solFiles.length === 0) return null;

  // Write to a unique temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sourcify-${addr.slice(2, 10)}-`));
  for (const file of solFiles) {
    // Preserve sub-directory structure (e.g. contracts/Token.sol)
    const relPath = typeof file.path === "string" ? file.path : file.name;
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content, "utf-8");
  }

  console.log(
    `[sourcify] Fetched ${solFiles.length} .sol file(s) for ${contractAddress} ` +
    `(${data.status ?? "unknown match"}) → ${tmpDir}`
  );
  return tmpDir;
}

module.exports = { fetchSourceFromSourcify };
