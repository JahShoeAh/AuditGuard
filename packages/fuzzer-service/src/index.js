"use strict";

const express = require("express");
const { enqueue, get } = require("./queue");

const app = express();
app.use(express.json());

const PORT = Number(process.env.FUZZER_SERVICE_PORT ?? 4001);

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// ── Submit a fuzzing job ─────────────────────────────────────────────────────
//
// POST /fuzz
// Body: {
//   contractAddress: string,      // EVM address of deployed contract
//   chainForkUrl?: string,        // JSON-RPC URL to fork (defaults to HEDERA_JSON_RPC_URL)
//   chainId?: string,             // defaults to "296" (Hedera testnet)
//   budgetSeconds?: number,       // fuzzing time limit, defaults to 120
//   tool?: "ityfuzz"|"mythril"|"manticore"|"heimdall"|"auto"  // defaults to "auto"
// }
// In "auto" mode all installed tools run and findings are merged.
// Response: { jobId: string, status: "queued" }

app.post("/fuzz", (req, res) => {
  const { contractAddress, chainForkUrl, chainId, budgetSeconds, tool } = req.body ?? {};

  if (!contractAddress || typeof contractAddress !== "string") {
    return res.status(400).json({ error: "contractAddress is required" });
  }

  const jobId = enqueue({
    contractAddress,
    chainForkUrl: chainForkUrl ?? process.env.HEDERA_JSON_RPC_URL,
    chainId: chainId ?? "296",
    budgetSeconds: Number(budgetSeconds ?? 120),
    tool: tool ?? "auto",
  });

  console.log(`[fuzzer-service] Job ${jobId} queued for ${contractAddress} (budget: ${budgetSeconds ?? 120}s)`);
  res.json({ jobId, status: "queued" });
});

// ── Poll for results ─────────────────────────────────────────────────────────
//
// GET /results/:jobId
// Response: {
//   jobId: string,
//   status: "queued"|"running"|"done"|"failed",
//   findings: Finding[],
//   toolUsed?: string,
//   elapsed?: number,
//   error?: string
// }

app.get("/results/:jobId", (req, res) => {
  const job = get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  const elapsed = job.finishedAt
    ? job.finishedAt - (job.startedAt ?? job.enqueuedAt)
    : Date.now() - job.enqueuedAt;

  res.json({
    jobId: job.id,
    status: job.status,
    findings: job.findings,
    toolUsed: job.toolUsed ?? null,
    elapsed: Math.round(elapsed / 1000),
    error: job.error ?? null,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const rpc = process.env.HEDERA_JSON_RPC_URL ?? "(not set — pass chainForkUrl in request)";
  console.log(`[fuzzer-service] Listening on port ${PORT}`);
  console.log(`[fuzzer-service] Default RPC: ${rpc}`);
  console.log(`[fuzzer-service] Corpus dir: ${process.env.ITYFUZZ_CORPUS_DIR ?? "packages/fuzzer-service/.corpus/ityfuzz"}`);
  console.log(`[fuzzer-service] Tools tried in order: ityfuzz → mythril → none (agent falls back to mock)`);
});
