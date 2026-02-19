import { ethers } from "ethers";
import { ContractClient, type PaymentItem } from "./shared/contract-client.js";
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

function defaultPayments(selfAddress: string): PaymentItem[] {
  return [
    {
      recipient: selfAddress,
      basePayment: ethers.parseUnits("10", 8),
      bonus: ethers.parseUnits("2", 8),
      reportFee: ethers.parseUnits("0.5", 8),
      paymentType: 0,
      description: "Audit job payment",
    },
  ];
}

async function main(): Promise<void> {
  ensureToggleOrSkip("RUN_LIVE_HEDERA_TESTS", "Hedera live tests");
  await ensureHttpReachableOrSkip(
    process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api",
    "Hedera JSON-RPC"
  );

  const client = ContractClient.fromPrivateKey(resolvePrivateKey());

  const reportFeeBase = await client.getReportFeeBase();
  const reportFeeDiscounted = await client.getReportFeeDiscounted();
  console.log("Report fee (base):", ethers.formatUnits(reportFeeBase, 8), "GUARD");
  console.log("Report fee (discounted):", ethers.formatUnits(reportFeeDiscounted, 8), "GUARD");

  const runSettlementWrite = process.env.RUN_SETTLEMENT_WRITE_TEST === "true";
  if (!runSettlementWrite) {
    console.log(
      "Skipping settleJob write-test. Set RUN_SETTLEMENT_WRITE_TEST=true and TEST_SETTLEMENT_JOB_ID to execute."
    );
    return;
  }

  const rawJobId = process.env.TEST_SETTLEMENT_JOB_ID;
  if (!rawJobId || !/^\d+$/.test(rawJobId)) {
    throw new Error("TEST_SETTLEMENT_JOB_ID must be set to a numeric job id when RUN_SETTLEMENT_WRITE_TEST=true");
  }

  const reportAgent = process.env.TEST_REPORT_AGENT_ADDRESS ?? client.getAddress();
  const payments = defaultPayments(client.getAddress());

  const tx = await client.settleJob(BigInt(rawJobId), payments, reportAgent);
  const receipt = await tx.wait();
  console.log("settleJob confirmed! tx:", receipt?.hash ?? tx.hash);
}

main().catch((err) => {
  console.error("Rewards test failed:", err);
  process.exit(1);
});
