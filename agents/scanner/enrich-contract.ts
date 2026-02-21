import { ethers } from "ethers";
import {
  enrichContractDiscovery,
  resolveScannerClassifierPipelineEnabled,
} from "./enrichment.js";

function parseArg(flag: string): string | null {
  const idx = process.argv.findIndex((value) => value === flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const contractAddress = String(parseArg("--address") ?? "").trim().toLowerCase();
  if (!ethers.isAddress(contractAddress)) {
    throw new Error(`Invalid --address value: ${contractAddress || "(missing)"}`);
  }

  const demoMode = process.env.DEMO_MODE === "true";
  const testMode = process.env.TEST_MODE === "true";
  const strictLive = String(process.env.STRICT_LIVE ?? (demoMode ? "false" : "true")).toLowerCase() !== "false";
  const classifierPipelineEnabled = resolveScannerClassifierPipelineEnabled({
    strictLive,
    demoMode,
    testMode,
  });

  const logger = {
    info: (msg: string) => process.stderr.write(`[scanner-enrich] ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`[scanner-enrich] ${msg}\n`),
  };

  const enrichment = await enrichContractDiscovery(
    contractAddress,
    { bytecode: null },
    classifierPipelineEnabled,
    logger
  );

  process.stdout.write(
    `${JSON.stringify({
      contractAddress,
      contractType: enrichment.contractType,
      riskScore: enrichment.riskScore,
      estimatedLOC: enrichment.estimatedLOC,
      classifier: enrichment.enrichedPayload,
      mode: enrichment.mode,
    })}\n`
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[scanner-enrich] error: ${message}\n`);
  process.exit(1);
});

