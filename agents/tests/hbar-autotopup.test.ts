import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import type { ContractClient } from "../shared/contract-client.js";

const RECIPIENT_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const DONOR_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const RECIPIENT_ADDRESS = new ethers.Wallet(RECIPIENT_KEY).address.toLowerCase();
const DONOR_ADDRESS = new ethers.Wallet(DONOR_KEY).address.toLowerCase();

type BalanceMap = Map<string, bigint>;

function createProvider(balanceMap: BalanceMap) {
  return {
    getBalance: vi.fn(async (address: string) => balanceMap.get(address.toLowerCase()) ?? 0n),
  } as unknown as ethers.JsonRpcProvider;
}

function createContracts(provider: ethers.JsonRpcProvider) {
  return {
    wallet: { provider },
  } as unknown as ContractClient;
}

async function loadModule() {
  vi.resetModules();
  return import("../shared/hbar-autotopup.js");
}

describe("hbar-autotopup", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.BID_HBAR_AUTO_TOPUP_ENABLED = "true";
    process.env.BID_HBAR_AUTO_TOPUP_DONOR_KEYS = DONOR_KEY;
    process.env.BID_HBAR_AUTO_TOPUP_MIN_HBAR = "0.25";
    process.env.BID_HBAR_AUTO_TOPUP_TARGET_HBAR = "1.00";
    process.env.BID_HBAR_AUTO_TOPUP_DONOR_MIN_HBAR = "1.50";
    process.env.BID_HBAR_AUTO_TOPUP_MAX_TRANSFER_HBAR = "2.00";
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it("returns ok without top-up when payer already has enough HBAR", async () => {
    const balances = new Map<string, bigint>([
      [RECIPIENT_ADDRESS, ethers.parseEther("0.5")],
    ]);
    const provider = createProvider(balances);
    const contracts = createContracts(provider);
    const { ensureOperationalHbar } = await loadModule();

    const result = await ensureOperationalHbar({
      contracts,
      recipientAddress: RECIPIENT_ADDRESS,
      requiredWei: ethers.parseEther("0.25"),
    });

    expect(result.ok).toBe(true);
    expect(result.attemptedTopUp).toBe(false);
    expect(result.toppedUpWei).toBe(0n);
  });

  it("fails with deterministic reason when donor has insufficient HBAR", async () => {
    const balances = new Map<string, bigint>([
      [RECIPIENT_ADDRESS, ethers.parseEther("0.01")],
      [DONOR_ADDRESS, ethers.parseEther("0.5")], // below donor reserve 1.50
    ]);
    const provider = createProvider(balances);
    const contracts = createContracts(provider);
    const { ensureOperationalHbar } = await loadModule();

    const result = await ensureOperationalHbar({
      contracts,
      recipientAddress: RECIPIENT_ADDRESS,
      requiredWei: ethers.parseEther("0.25"),
    });

    expect(result.ok).toBe(false);
    expect(result.attemptedTopUp).toBe(true);
    expect(result.reasonCode).toBe("insufficient_payer_hbar_after_topup");
    expect(result.reason).toContain("after auto top-up attempt");
  });

  it("tops up payer balance when donor has available HBAR", async () => {
    const balances = new Map<string, bigint>([
      [RECIPIENT_ADDRESS, ethers.parseEther("0.01")],
      [DONOR_ADDRESS, ethers.parseEther("10.00")],
    ]);
    const provider = createProvider(balances);
    const contracts = createContracts(provider);

    const sendSpy = vi
      .spyOn(ethers.Wallet.prototype, "sendTransaction")
      .mockImplementation(async function (tx: ethers.TransactionRequest) {
        const from = this.address.toLowerCase();
        const to = String(tx.to).toLowerCase();
        const value = BigInt(tx.value ?? 0);
        balances.set(from, (balances.get(from) ?? 0n) - value);
        balances.set(to, (balances.get(to) ?? 0n) + value);
        return {
          hash: "0xtest",
          wait: async () => ({ status: 1 }),
        } as unknown as ethers.TransactionResponse;
      });

    const { ensureOperationalHbar } = await loadModule();

    const result = await ensureOperationalHbar({
      contracts,
      recipientAddress: RECIPIENT_ADDRESS,
      requiredWei: ethers.parseEther("0.25"),
    });

    expect(sendSpy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.attemptedTopUp).toBe(true);
    expect(result.toppedUpWei > 0n).toBe(true);
  });
});
