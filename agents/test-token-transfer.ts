import { ethers } from "ethers";
import { ContractClient } from "./shared/contract-client.js";
import {
  ensureHttpReachableOrSkip,
  ensureToggleOrSkip,
  skipOrFail,
} from "./scripts/live-preflight.js";

function resolvePrivateKey(): string {
  const pk = process.env.HEDERA_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    skipOrFail("missing HEDERA_PRIVATE_KEY/OPERATOR_PRIVATE_KEY");
  }
  return pk;
}

async function main(): Promise<void> {
  ensureToggleOrSkip("RUN_LIVE_HEDERA_TESTS", "Hedera live tests");
  await ensureHttpReachableOrSkip(
    process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api",
    "Hedera JSON-RPC"
  );

  const client = ContractClient.fromPrivateKey(resolvePrivateKey());
  const myAddress = client.getAddress();

  console.log("Wallet address:", myAddress);

  const balance = await client.getGuardBalance(myAddress);
  console.log("GUARD balance:", ethers.formatUnits(balance, 8));

  const spender = String(client.paymentSettlement.target);
  const allowance = await client.getGuardAllowance(myAddress, spender);
  console.log("Allowance to PaymentSettlement:", ethers.formatUnits(allowance, 8));

  const minApproval = ethers.parseUnits("100", 8);
  if (allowance < minApproval) {
    console.log("Approving tokens...");
    const tx = await client.ensureGuardAllowance(spender, ethers.parseUnits("1000", 8));
    if (tx) {
      const receipt = await tx.wait();
      console.log("Approval confirmed! tx:", receipt?.hash ?? tx.hash);
    }
  } else {
    console.log("Allowance already sufficient.");
  }

  const postAllowance = await client.getGuardAllowance(myAddress, spender);
  console.log("Post-approval allowance:", ethers.formatUnits(postAllowance, 8));
}

main().catch((err) => {
  console.error("Token transfer test failed:", err);
  process.exit(1);
});
