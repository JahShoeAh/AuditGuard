import { ethers } from "ethers";
import { ContractClient } from "./contract-client.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export interface EnsureOperationalHbarInput {
  contracts: ContractClient;
  recipientAddress: string;
  requiredWei: bigint;
  logger?: LoggerLike;
}

export interface EnsureOperationalHbarResult {
  ok: boolean;
  balanceWei: bigint;
  attemptedTopUp: boolean;
  toppedUpWei: bigint;
  reason?: string;
  reasonCode?: "insufficient_payer_hbar" | "insufficient_payer_hbar_after_topup" | "hbar_topup_failed";
  donorAddressesUsed?: string[];
}

const TOP_UP_ENABLED = (process.env.BID_HBAR_AUTO_TOPUP_ENABLED ?? "true") !== "false";
const MIN_REQUIRED_WEI = parseHbarUnits(process.env.BID_HBAR_AUTO_TOPUP_MIN_HBAR ?? "0.25");
const TARGET_BALANCE_WEI = parseHbarUnits(process.env.BID_HBAR_AUTO_TOPUP_TARGET_HBAR ?? "1.00");
const DONOR_MIN_RESERVE_WEI = parseHbarUnits(process.env.BID_HBAR_AUTO_TOPUP_DONOR_MIN_HBAR ?? "1.50");
const TOP_UP_MAX_TRANSFER_WEI = parseHbarUnits(process.env.BID_HBAR_AUTO_TOPUP_MAX_TRANSFER_HBAR ?? "2.00");
const DEFAULT_DONOR_KEY_ENV_NAMES = [
  "SCANNER_PRIVATE_KEY",
  "STATIC_PRIVATE_KEY",
  "FUZZER_PRIVATE_KEY",
  "LLM_PRIVATE_KEY",
  "DEPENDENCY_PRIVATE_KEY",
  "REPORT_PRIVATE_KEY",
  "ALERT_PRIVATE_KEY",
  "OPERATOR_PRIVATE_KEY",
  "AGENT_REGISTRY_OWNER_PRIVATE_KEY",
  "HEDERA_PRIVATE_KEY",
];

function parseHbarUnits(value: string): bigint {
  try {
    return ethers.parseEther(value);
  } catch {
    return 0n;
  }
}

function asPrivateKey(raw: string): string | null {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) return null;
  return normalized.toLowerCase();
}

function resolveDonorKeys(): string[] {
  const custom = (process.env.BID_HBAR_AUTO_TOPUP_DONOR_KEYS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const candidates = custom.length > 0 ? custom : DEFAULT_DONOR_KEY_ENV_NAMES;
  const out = new Set<string>();
  for (const candidate of candidates) {
    const raw = candidate.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(candidate)
      ? candidate
      : (process.env[candidate] ?? "");
    const parsed = asPrivateKey(raw);
    if (parsed) out.add(parsed);
  }
  return [...out];
}

function maskAddress(addr: string): string {
  const normalized = addr.toLowerCase();
  return `${normalized.slice(0, 10)}...${normalized.slice(-4)}`;
}

function resolveDonorAddresses(keys: string[]): string[] {
  const addresses = new Set<string>();
  for (const key of keys) {
    try {
      const wallet = new ethers.Wallet(key);
      addresses.add(wallet.address.toLowerCase());
    } catch {
      // ignore invalid private keys
    }
  }
  return [...addresses];
}

export function getHbarTopUpConfig() {
  const donorKeys = resolveDonorKeys();
  const donorAddresses = resolveDonorAddresses(donorKeys);
  const donorWarning = donorAddresses.length === 0
    ? "No valid donor wallets resolved for HBAR top-up"
    : donorAddresses.length === 1
      ? "Only one unique donor wallet resolved for HBAR top-up"
      : undefined;
  return {
    enabled: TOP_UP_ENABLED,
    minRequiredWei: MIN_REQUIRED_WEI,
    targetWei: TARGET_BALANCE_WEI,
    donorsConfigured: donorAddresses.length,
    donorAddressesMasked: donorAddresses.map(maskAddress),
    donorWarning,
  };
}

export async function ensureOperationalHbar(
  input: EnsureOperationalHbarInput
): Promise<EnsureOperationalHbarResult> {
  const { contracts, recipientAddress, requiredWei, logger } = input;
  const provider = contracts.wallet.provider;
  if (!provider) {
    return {
      ok: false,
      balanceWei: 0n,
      attemptedTopUp: false,
      toppedUpWei: 0n,
      reason: "HBAR top-up unavailable: missing provider",
      reasonCode: "hbar_topup_failed",
      donorAddressesUsed: [],
    };
  }

  const required = requiredWei > 0n ? requiredWei : MIN_REQUIRED_WEI;
  const target = TARGET_BALANCE_WEI > required ? TARGET_BALANCE_WEI : required;
  const initialBalance = await provider.getBalance(recipientAddress);
  if (initialBalance >= required) {
    return {
      ok: true,
      balanceWei: initialBalance,
      attemptedTopUp: false,
      toppedUpWei: 0n,
      donorAddressesUsed: [],
    };
  }

  if (!TOP_UP_ENABLED) {
    return {
      ok: false,
      balanceWei: initialBalance,
      attemptedTopUp: false,
      toppedUpWei: 0n,
      reason: "Insufficient payer HBAR for transaction fees",
      reasonCode: "insufficient_payer_hbar",
      donorAddressesUsed: [],
    };
  }

  const donorKeys = resolveDonorKeys();
  const donorAddressesUsed = new Set<string>();
  if (donorKeys.length === 0) {
    return {
      ok: false,
      balanceWei: initialBalance,
      attemptedTopUp: true,
      toppedUpWei: 0n,
      reason: "Insufficient payer HBAR and no valid top-up donor keys configured",
      reasonCode: "hbar_topup_failed",
      donorAddressesUsed: [],
    };
  }

  let currentBalance = initialBalance;
  let toppedUpWei = 0n;
  const recipientLower = recipientAddress.toLowerCase();

  for (const donorKey of donorKeys) {
    if (currentBalance >= required) break;
    let donorWallet: ethers.Wallet;
    try {
      donorWallet = new ethers.Wallet(donorKey, provider);
    } catch {
      continue;
    }
    const donorAddress = donorWallet.address.toLowerCase();
    if (donorAddress === recipientLower) continue;
    donorAddressesUsed.add(donorAddress);

    let donorBalance = 0n;
    try {
      donorBalance = await provider.getBalance(donorAddress);
    } catch {
      continue;
    }

    const available = donorBalance > DONOR_MIN_RESERVE_WEI
      ? donorBalance - DONOR_MIN_RESERVE_WEI
      : 0n;
    if (available <= 0n) continue;

    const missing = target > currentBalance ? target - currentBalance : 0n;
    if (missing <= 0n) break;

    let transferAmount = missing;
    if (TOP_UP_MAX_TRANSFER_WEI > 0n && transferAmount > TOP_UP_MAX_TRANSFER_WEI) {
      transferAmount = TOP_UP_MAX_TRANSFER_WEI;
    }
    if (transferAmount > available) {
      transferAmount = available;
    }
    if (transferAmount <= 0n) continue;

    try {
      logger?.info?.(
        `[HBAR TopUp] Funding payer wallet from ${donorAddress.slice(0, 10)}... ` +
        `(+${ethers.formatEther(transferAmount)} HBAR)`
      );
      const tx = await donorWallet.sendTransaction({
        to: recipientAddress,
        value: transferAmount,
      });
      await tx.wait();
      toppedUpWei += transferAmount;
      currentBalance = await provider.getBalance(recipientAddress);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger?.warn?.(`[HBAR TopUp] Transfer failed from ${donorAddress.slice(0, 10)}...: ${error}`);
    }
  }

  if (currentBalance >= required) {
    return {
      ok: true,
      balanceWei: currentBalance,
      attemptedTopUp: true,
      toppedUpWei,
      donorAddressesUsed: [...donorAddressesUsed],
    };
  }

  return {
    ok: false,
    balanceWei: currentBalance,
    attemptedTopUp: true,
    toppedUpWei,
    reason: "Insufficient payer HBAR for transaction fees after auto top-up attempt (donors exhausted or unable to fund gas)",
    reasonCode: "insufficient_payer_hbar_after_topup",
    donorAddressesUsed: [...donorAddressesUsed],
  };
}
