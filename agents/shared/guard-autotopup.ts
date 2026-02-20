import { ethers } from "ethers";
import { CONFIG } from "./config.js";
import { ContractClient } from "./contract-client.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export interface EnsureBidCollateralBalanceInput {
  contracts: ContractClient;
  recipientAddress: string;
  requiredWei: bigint;
  logger?: LoggerLike;
}

export interface EnsureBidCollateralBalanceResult {
  ok: boolean;
  balanceWei: bigint;
  attemptedTopUp: boolean;
  toppedUpWei: bigint;
  reason?: string;
  donorAddressesUsed?: string[];
}

const GUARD_DECIMALS = 8;
const TOP_UP_ENABLED = (process.env.BID_GUARD_AUTO_TOPUP_ENABLED ?? "true") !== "false";
const TOP_UP_BUFFER_WEI = parseGuardUnits(process.env.BID_GUARD_AUTO_TOPUP_BUFFER_GUARD ?? "50");
const DONOR_MIN_RESERVE_WEI = parseGuardUnits(process.env.BID_GUARD_AUTO_TOPUP_DONOR_MIN_GUARD ?? "200");
const TOP_UP_MAX_TRANSFER_WEI = parseGuardUnits(process.env.BID_GUARD_AUTO_TOPUP_MAX_TRANSFER_GUARD ?? "500");
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

function parseGuardUnits(value: string): bigint {
  try {
    return ethers.parseUnits(value, GUARD_DECIMALS);
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
  const custom = (process.env.BID_GUARD_AUTO_TOPUP_DONOR_KEYS ?? "")
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

export async function ensureBidCollateralBalance(
  input: EnsureBidCollateralBalanceInput
): Promise<EnsureBidCollateralBalanceResult> {
  const { contracts, recipientAddress, requiredWei, logger } = input;
  const initialBalance = await contracts.getGuardBalance(recipientAddress);
  if (initialBalance >= requiredWei) {
    return {
      ok: true,
      balanceWei: initialBalance,
      attemptedTopUp: false,
      toppedUpWei: 0n,
    };
  }

  if (!TOP_UP_ENABLED) {
    return {
      ok: false,
      balanceWei: initialBalance,
      attemptedTopUp: false,
      toppedUpWei: 0n,
      reason: "Insufficient GUARD balance for bid collateral",
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
      reason: "Insufficient GUARD balance and no valid top-up donor keys configured",
      donorAddressesUsed: [],
    };
  }

  let currentBalance = initialBalance;
  let toppedUpWei = 0n;
  const recipientLower = recipientAddress.toLowerCase();
  const desiredTarget = requiredWei + TOP_UP_BUFFER_WEI;

  for (const donorKey of donorKeys) {
    if (currentBalance >= requiredWei) break;
    let donor: ContractClient;
    try {
      donor = ContractClient.fromPrivateKey(donorKey);
    } catch {
      continue;
    }
    const donorAddress = donor.getAddress();
    if (donorAddress.toLowerCase() === recipientLower) continue;
    donorAddressesUsed.add(donorAddress.toLowerCase());

    let donorBalance = 0n;
    try {
      donorBalance = await donor.getGuardBalance(donorAddress);
    } catch {
      continue;
    }

    const available = donorBalance > DONOR_MIN_RESERVE_WEI
      ? donorBalance - DONOR_MIN_RESERVE_WEI
      : 0n;
    if (available <= 0n) continue;

    const missing = desiredTarget > currentBalance ? desiredTarget - currentBalance : 0n;
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
        `[TopUp] Funding collateral wallet from ${donorAddress.slice(0, 10)}... ` +
        `(+${ethers.formatUnits(transferAmount, GUARD_DECIMALS)} GUARD)`
      );
      const tx = await donor.transferGuard(recipientAddress, transferAmount);
      await tx.wait();
      toppedUpWei += transferAmount;
      currentBalance = await contracts.getGuardBalance(recipientAddress);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger?.warn?.(`[TopUp] Transfer failed from ${donorAddress.slice(0, 10)}...: ${error}`);
    }
  }

  if (currentBalance >= requiredWei) {
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
    reason: "Insufficient GUARD balance for bid collateral after auto top-up attempt (donors exhausted or unable to pay transfer fees)",
    donorAddressesUsed: [...donorAddressesUsed],
  };
}

export function getBidCollateralTopUpConfig() {
  const donorKeys = resolveDonorKeys();
  const donorAddresses = resolveDonorAddresses(donorKeys);
  const donorWarning = donorAddresses.length === 0
    ? "No valid donor wallets resolved for GUARD top-up"
    : donorAddresses.length === 1
      ? "Only one unique donor wallet resolved for GUARD top-up"
      : undefined;
  return {
    enabled: TOP_UP_ENABLED,
    donorsConfigured: donorAddresses.length,
    donorAddressesMasked: donorAddresses.map(maskAddress),
    donorWarning,
    minBidCollateralGuard: CONFIG.bidPolicy.minCollateralGuard,
  };
}
