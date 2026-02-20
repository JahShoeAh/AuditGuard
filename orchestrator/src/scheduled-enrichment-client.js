import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseEnrichmentOutput(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("scanner enrichment returned empty output");
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error(`scanner enrichment returned non-JSON output: ${lines[lines.length - 1]}`);
  }

  const contractType = String(parsed?.contractType ?? "").trim() || "unknown";
  const riskScore = Number(parsed?.riskScore ?? 0);
  const estimatedLOC = Number(parsed?.estimatedLOC ?? 0);
  if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    throw new Error(`invalid enrichment riskScore: ${parsed?.riskScore}`);
  }
  if (!Number.isFinite(estimatedLOC) || estimatedLOC < 0) {
    throw new Error(`invalid enrichment estimatedLOC: ${parsed?.estimatedLOC}`);
  }

  return {
    contractType,
    riskScore,
    estimatedLOC,
    classifier: parsed?.classifier && typeof parsed.classifier === "object" ? parsed.classifier : null,
    mode: String(parsed?.mode || ""),
  };
}

export async function enrichScheduledDiscovery(contractAddress, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? process.env.ORCHESTRATOR_SCHEDULED_ENRICHMENT_TIMEOUT_MS ?? 45000);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "--workspace",
        "agents",
        "exec",
        "tsx",
        "scanner/enrich-contract.ts",
        "--address",
        String(contractAddress),
      ],
      {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`scanner enrichment timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `scanner enrichment process failed (exit=${code}): ${stderr.trim() || stdout.trim() || "unknown error"}`
          )
        );
        return;
      }
      try {
        resolve(parseEnrichmentOutput(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}
