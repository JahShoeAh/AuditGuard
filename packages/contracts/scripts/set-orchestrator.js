/**
 * set-orchestrator.js
 *
 * Updates AuditAuction.orchestrator on-chain.
 *
 * Run from packages/contracts:
 *   npx hardhat run scripts/set-orchestrator.js --network hedera_testnet
 *
 * Optional overrides:
 *   ORCHESTRATOR_ADDRESS=0x... AUCTION_ADDRESS=0x... npx hardhat run scripts/set-orchestrator.js --network hedera_testnet
 */

const path = require("path");
const { ethers } = require("hardhat");

const config = require(path.resolve(__dirname, "../../sdk/config.json"));
const abiJson = require(path.resolve(__dirname, "../../sdk/abis/AuditAuction.json"));

const DEFAULT_AUCTION = "0x95A0A0e78a32c849526d6AC32e98c6829FB2Cd88";
const DEFAULT_ORCHESTRATOR = "0x49b10D6983BFB1BcA4706E34151fd83e7FEC8B9b";

function resolveAuctionAddress() {
  return (
    process.env.AUCTION_ADDRESS ||
    config?.contracts?.auctionContract?.evmAddress ||
    config?.contracts?.auction?.evmAddress ||
    DEFAULT_AUCTION
  );
}

function resolveOrchestratorAddress() {
  return (
    process.env.ORCHESTRATOR_ADDRESS ||
    process.env.ORCHESTRATOR_EVM_ADDRESS ||
    DEFAULT_ORCHESTRATOR
  );
}

async function main() {
  const [owner] = await ethers.getSigners();
  const auctionAddress = resolveAuctionAddress();
  const orchestratorAddr = resolveOrchestratorAddress();

  const auction = new ethers.Contract(
    auctionAddress,
    abiJson.abi || abiJson,
    owner
  );

  console.log("Signer:", owner.address);
  console.log("AuditAuction:", auctionAddress);
  console.log("Setting orchestrator to:", orchestratorAddr);

  const currentOrchestrator = await auction.orchestrator();
  console.log("Current orchestrator:", currentOrchestrator);

  if (currentOrchestrator.toLowerCase() === orchestratorAddr.toLowerCase()) {
    console.log("No-op: orchestrator already set.");
    return;
  }

  const tx = await auction.setOrchestrator(orchestratorAddr);
  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    throw new Error(`setOrchestrator tx failed: ${tx.hash}`);
  }

  console.log("Done. TX:", tx.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
