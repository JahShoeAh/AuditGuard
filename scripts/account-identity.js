const { ethers } = require("ethers");

const DEFAULT_MIRROR_BASE_URL = process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.LIVE_PREFLIGHT_MIRROR_TIMEOUT_MS || "8000");

function normalizeAccountId(raw) {
  return String(raw || "").trim().replace(/^['"]|['"]$/g, "");
}

function normalizePrivateKey(rawKey) {
  const raw = String(rawKey || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) throw new Error("private_key_empty");
  const stripped = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error("private_key_not_ecdsa_hex32");
  }
  return `0x${stripped}`;
}

function deriveEvmAddressFromPrivateKey(rawKey) {
  return new ethers.Wallet(normalizePrivateKey(rawKey)).address.toLowerCase();
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveMirrorEvmAddress(accountId, options = {}) {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return { ok: false, reasonCode: "missing_account_id", mirrorAddress: null, error: "missing account id" };
  }
  const mirrorBaseUrl = String(options.mirrorBaseUrl || DEFAULT_MIRROR_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const url = `${mirrorBaseUrl}/api/v1/accounts/${normalized}`;

  try {
    const response = await withTimeout(fetch(url), timeoutMs, `mirror lookup for ${normalized}`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        reasonCode: "mirror_lookup_failed",
        mirrorAddress: null,
        error: `mirror ${response.status} ${body.slice(0, 120)}`.trim(),
      };
    }
    const body = await response.json();
    const evmAddress = String(body?.evm_address || "").trim().toLowerCase();
    if (evmAddress && ethers.isAddress(evmAddress)) {
      return { ok: true, reasonCode: "mirror_lookup_ok", mirrorAddress: evmAddress, error: null };
    }
    return {
      ok: false,
      reasonCode: "mirror_evm_address_missing",
      mirrorAddress: null,
      error: "account exists but mirror returned no evm_address",
    };
  } catch (err) {
    return {
      ok: false,
      reasonCode: "mirror_lookup_failed",
      mirrorAddress: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function verifyAccountKeyPair({ accountId, privateKey, mirrorBaseUrl, timeoutMs }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    return {
      ok: false,
      reasonCode: "missing_account_id",
      accountId: normalizedAccountId,
      derivedAddress: null,
      mirrorAddress: null,
      detail: "missing account id",
    };
  }

  let derivedAddress = null;
  try {
    derivedAddress = deriveEvmAddressFromPrivateKey(privateKey);
  } catch (err) {
    return {
      ok: false,
      reasonCode: "private_key_invalid",
      accountId: normalizedAccountId,
      derivedAddress: null,
      mirrorAddress: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const mirror = await resolveMirrorEvmAddress(normalizedAccountId, { mirrorBaseUrl, timeoutMs });
  if (!mirror.ok) {
    return {
      ok: false,
      reasonCode: mirror.reasonCode,
      accountId: normalizedAccountId,
      derivedAddress,
      mirrorAddress: null,
      detail: mirror.error || "mirror lookup failed",
    };
  }

  if (mirror.mirrorAddress !== derivedAddress) {
    return {
      ok: false,
      reasonCode: "account_key_pair_mismatch",
      accountId: normalizedAccountId,
      derivedAddress,
      mirrorAddress: mirror.mirrorAddress,
      detail: `derived=${derivedAddress} mirror=${mirror.mirrorAddress}`,
    };
  }

  return {
    ok: true,
    reasonCode: "account_key_pair_ok",
    accountId: normalizedAccountId,
    derivedAddress,
    mirrorAddress: mirror.mirrorAddress,
    detail: `derived=${derivedAddress} mirror=${mirror.mirrorAddress}`,
  };
}

module.exports = {
  normalizeAccountId,
  normalizePrivateKey,
  deriveEvmAddressFromPrivateKey,
  resolveMirrorEvmAddress,
  verifyAccountKeyPair,
};

