import { ethers } from "ethers";
import { ContractClient } from "./shared/contract-client.js";

function resolvePrivateKey(): string {
  const pk = process.env.HEDERA_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error("Set HEDERA_PRIVATE_KEY or OPERATOR_PRIVATE_KEY in env");
  }
  return pk;
}

function asStringArray(csv: string): string[] {
  return csv
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const client = ContractClient.fromPrivateKey(resolvePrivateKey());
  const myAddress = client.getAddress();
  const agentId = process.env.TEST_AGENT_ID ?? "scanner-001";
  const ucpEndpoint = process.env.TEST_AGENT_UCP_ENDPOINT ?? `openclaws://${agentId}`;
  const specializations = asStringArray(process.env.TEST_AGENT_SPECIALIZATIONS ?? "solidity,security");
  const stakeAmount = ethers.parseUnits(process.env.TEST_AGENT_STAKE_GUARD ?? "100", 8);

  const existing = (await client.getAgent(myAddress)) as {
    agentAddress?: string;
    status?: number;
    stakedAmount?: bigint;
  };

  if (existing?.agentAddress && existing.agentAddress !== ethers.ZeroAddress) {
    console.log("Already registered:", existing.agentAddress);
    console.log("Current stake:", ethers.formatUnits(existing.stakedAmount ?? 0n, 8));
    console.log("Active:", await client.isActiveAgent(myAddress));
    return;
  }

  const registryAddress = String(client.agentRegistry.target);
  const allowanceTx = await client.ensureGuardAllowance(registryAddress, stakeAmount);
  if (allowanceTx) {
    await allowanceTx.wait();
    console.log("Allowance confirmed for AgentRegistry.");
  }

  console.log("Registering agent with stake...");
  const tx = await client.registerAgent(agentId, ucpEndpoint, specializations, stakeAmount);
  const receipt = await tx.wait();
  console.log("Registration confirmed! tx:", receipt?.hash ?? tx.hash);
  console.log("Agent active:", await client.isActiveAgent(myAddress));
}

main().catch((err) => {
  console.error("Staking test failed:", err);
  process.exit(1);
});
