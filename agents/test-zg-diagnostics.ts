import { ethers } from "ethers";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizePrivateKey(raw: string): string {
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  console.log("=== 0g Broker Diagnostics ===\n");

  const privateKey = requiredEnv("ZG_PRIVATE_KEY");
  const rpcUrl = requiredEnv("ZG_RPC_URL");
  const providerAddress = requiredEnv("ZG_PROVIDER_ADDRESS");

  console.log("1. Environment Check:");
  console.log("   - ZG_PRIVATE_KEY:", `${privateKey.slice(0, 10)}...`);
  console.log("   - ZG_RPC_URL:", rpcUrl);
  console.log("   - ZG_PROVIDER_ADDRESS:", providerAddress);

  console.log("\n2. RPC Connectivity:");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const blockNumber = await provider.getBlockNumber();
  console.log("   RPC connected. Current block:", blockNumber);

  console.log("\n3. Wallet Creation:");
  const wallet = new ethers.Wallet(normalizePrivateKey(privateKey), provider);
  console.log("   Wallet address:", wallet.address);

  console.log("\n4. Broker Initialization:");
  const { createZGComputeNetworkBroker } = await import("@0glabs/0g-serving-broker");
  const broker: any = await createZGComputeNetworkBroker(wallet);
  console.log("   Broker initialized successfully");

  console.log("\n5. Ledger Check:");
  const ledger = await broker.ledger.getLedger();
  console.log("   Available balance:", String(ledger?.availableBalance ?? "0"));
  console.log("   Total balance:", String(ledger?.totalBalance ?? "0"));

  console.log("\n6. Provider Metadata:");
  const meta = await broker.inference.getServiceMetadata(providerAddress);
  console.log("   Endpoint:", String(meta?.endpoint ?? ""));
  console.log("   Model:", String(meta?.model ?? ""));

  console.log("\n=== All diagnostics passed ===");
}

main().catch((err) => {
  console.error("0g diagnostics failed:", errorMessage(err));
  process.exit(1);
});
