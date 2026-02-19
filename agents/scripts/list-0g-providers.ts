import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, "..", ".env") });

async function main() {
  const pk = process.env.ZG_PRIVATE_KEY;
  if (!pk) {
    console.error("Set ZG_PRIVATE_KEY in agents/.env");
    process.exit(1);
  }

  const rpcUrl = process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";
  console.log(`Connecting to ${rpcUrl}...`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  console.log(`Wallet: ${wallet.address}`);

  const broker = await createZGComputeNetworkBroker(wallet);
  console.log("Broker initialized. Listing services...\n");

  const services = await broker.inference.listService();
  if (!services || services.length === 0) {
    console.log("No services found on this network.");
    return;
  }

  for (let i = 0; i < services.length; i++) {
    const s: any = services[i];
    console.log(`── Service ${i + 1} ──`);
    for (const [k, v] of Object.entries(s)) {
      console.log(`  ${k}: ${String(v).slice(0, 200)}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
