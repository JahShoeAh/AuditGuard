import crypto from "node:crypto";
import {
  reportId,
  normalizeDeployer,
  EMPTY_FINDINGS,
} from "../../packages/sdk/db/report-types.js";
import { saveReport, reportExists } from "../../packages/sdk/db/report-db.js";

const REPORT_CLAUDE_ENRICHMENT_ENABLED =
  (process.env.REPORT_CLAUDE_ENRICHMENT_ENABLED ?? "false") === "true";
const REPORT_CLAUDE_MAX_TOKENS = (() => {
  const parsed = Number(process.env.CLAUDE_REPORT_MAX_TOKENS ?? "320");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 320;
})();
const MIRROR_NODE_BASE = (
  process.env.SCANNER_MIRROR_NODE ??
  process.env.HEDERA_MIRROR_NODE_URL ??
  "https://testnet.mirrornode.hedera.com"
).replace(/\/$/, "");
const CANONICAL_CONTRACT_TYPES = new Set([
  "lending",
  "dex",
  "staking",
  "bridge",
  "vault",
  "derivatives",
  "oracle",
  "governance",
  "nft",
  "unknown",
]);
let loggedReportHaikuOverride = false;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function totalFindings(findings) {
  return findings.reduce((sum, finding) => {
    const explicitCount = toNumber(finding?.findingsCount, NaN);
    if (Number.isFinite(explicitCount)) return sum + Math.max(0, Math.floor(explicitCount));
    return sum + 1;
  }, 0);
}

/**
 * Accepts either aggregate findings ({ findingsCount, criticalCount }) or
 * per-finding items ({ severity }).
 * @param {Array<Record<string, unknown>>} findings
 * @returns {import("../../packages/sdk/db/report-types.js").FindingsBySeverity}
 */
function calculateSeverity(findings) {
  const counts = { ...EMPTY_FINDINGS };

  for (const finding of findings) {
    const criticalCount = toNumber(finding?.criticalCount, NaN);
    const findingsCount = toNumber(finding?.findingsCount, NaN);

    if (Number.isFinite(findingsCount) || Number.isFinite(criticalCount)) {
      const critical = Math.max(0, Math.floor(Number.isFinite(criticalCount) ? criticalCount : 0));
      const total = Math.max(0, Math.floor(Number.isFinite(findingsCount) ? findingsCount : critical));
      counts.critical += critical;
      counts.high += Math.max(0, total - critical);
      continue;
    }

    const sev = String(finding?.severity ?? finding?.level ?? "info").toLowerCase();
    if (sev in counts) counts[sev] += 1;
  }

  return counts;
}

function extractTags(findings) {
  const tags = new Set();
  const keywords = ["reentrancy", "overflow", "underflow", "access control", "oracle"];
  for (const finding of findings) {
    const text = String(finding?.description ?? finding?.details ?? "").toLowerCase();
    for (const keyword of keywords) {
      if (text.includes(keyword)) tags.add(keyword);
    }
  }
  return [...tags];
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isMissing(value) {
  const normalized = normalizeText(value).toLowerCase();
  return (
    !normalized ||
    normalized === "unknown" ||
    normalized === "n/a" ||
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "0x0000000000000000000000000000000000000000"
  );
}

function firstPresent(candidates) {
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!isMissing(text)) return text;
  }
  return "";
}

function normalizeContractTypeCandidate(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "unknown";
  if (CANONICAL_CONTRACT_TYPES.has(raw)) return raw;

  if (/(loan|lending|money market)/.test(raw)) return "lending";
  if (/(dex|amm|swap|exchange|liquidity)/.test(raw)) return "dex";
  if (/(stake|staking|validator)/.test(raw)) return "staking";
  if (/(bridge|cross[- ]?chain)/.test(raw)) return "bridge";
  if (/(vault|treasury|yield|strategy)/.test(raw)) return "vault";
  return "unknown";
}

function resolveClaudeHaikuModel() {
  const fallback = "claude-haiku-4-5-20251001";
  const configured = normalizeText(
    process.env.CLAUDE_HAIKU_MODEL ??
    process.env.CLAUDE_REPORT_MODEL ??
    process.env.CLAUDE_RISK_MODEL ??
    fallback
  );
  const normalized = configured.toLowerCase();
  const retiredHaikuModels = new Set([
    "claude-3-5-haiku-latest",
    "claude-3-5-haiku-20241022",
    "claude-3-haiku-20240307",
  ]);
  if (retiredHaikuModels.has(normalized)) {
    if (!loggedReportHaikuOverride) {
      console.warn(
        `[report-writer] Claude model override: configured '${configured}' is retired. ` +
        `Forcing '${fallback}'.`
      );
      loggedReportHaikuOverride = true;
    }
    return fallback;
  }
  if (normalized.includes("haiku")) return configured;
  if (!loggedReportHaikuOverride) {
    console.warn(
      `[report-writer] Claude model override: configured '${configured}' is not Haiku. ` +
      `Forcing '${fallback}'.`
    );
    loggedReportHaikuOverride = true;
  }
  return fallback;
}

function resolveMetadata(job, findings) {
  const safeFindings = Array.isArray(findings) ? findings : [];
  const contractAddress = firstPresent([
    job?.contractAddress,
    ...safeFindings.map((finding) => finding?.contractAddress),
  ]);
  const deployerAddress = firstPresent([
    job?.deployerAddress,
    ...safeFindings.map((finding) => finding?.deployerAddress),
  ]);
  const contractType = firstPresent([
    job?.contractType,
    ...safeFindings.map((finding) => finding?.contractType),
  ]);
  const contractChain = firstPresent([
    job?.contractChain,
    ...safeFindings.map((finding) => finding?.contractChain),
    "hedera-testnet",
  ]);
  return {
    contractAddress: contractAddress || "unknown",
    deployerAddress: deployerAddress || "unknown",
    contractType: contractType || "unknown",
    contractChain: contractChain || "hedera-testnet",
  };
}

function extractJsonObject(raw) {
  const text = normalizeText(raw);
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const objectMatch = text.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0] : null;
}

function parseReportEnrichment(raw) {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(candidate.replace(/,\s*([\]}])/g, "$1"));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const contractType = normalizeContractTypeCandidate(parsed.contractType);
  const riskNarrative =
    typeof parsed.riskNarrative === "string"
      ? parsed.riskNarrative.trim()
      : typeof parsed.narrative === "string"
        ? parsed.narrative.trim()
        : "";

  return { contractType, riskNarrative };
}

function buildBaselineNarrative(metadata, severity, total) {
  const concerns = [];
  if (severity.critical > 0) concerns.push("critical exploitability paths");
  if (severity.high > 0) concerns.push("high-severity logic and access control weaknesses");
  if (severity.medium > 0) concerns.push("state-management and input-validation weaknesses");
  if (severity.low > 0 || severity.info > 0) concerns.push("hardening and observability gaps");
  if (!concerns.length) concerns.push("potential latent risks that were not fully observable from submitted findings");

  const typeLabel = isMissing(metadata.contractType) ? "smart contract" : `${metadata.contractType} contract`;
  const evidence =
    total > 0
      ? `The current run produced ${total} total finding${total === 1 ? "" : "s"}, including ${severity.critical} critical and ${severity.high} high issues.`
      : "No concrete finding payloads were submitted for this run, so this summary is provisional and should be treated as a risk-screening baseline.";

  return (
    `This report provides a preliminary security assessment for the ${typeLabel} at ${metadata.contractAddress}. ` +
    `${evidence} Priority review should focus on ${concerns.join(", ")}, with particular attention to external call safety, privilege boundaries, and economic abuse scenarios under adversarial conditions. ` +
    `A manual code review and targeted invariant testing are still required before production deployment.`
  );
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function hydrateDeployerFromMirror(metadata) {
  if (!isMissing(metadata.deployerAddress)) return metadata.deployerAddress;
  if (isMissing(metadata.contractAddress)) return metadata.deployerAddress;
  if (!String(metadata.contractChain).toLowerCase().includes("hedera")) return metadata.deployerAddress;

  const address = metadata.contractAddress.toLowerCase();
  const contractDetail = await fetchJson(`${MIRROR_NODE_BASE}/api/v1/contracts/${address}`);
  const contractId = normalizeText(contractDetail?.contract_id);
  if (!contractId) return metadata.deployerAddress;

  const executionDetail = await fetchJson(
    `${MIRROR_NODE_BASE}/api/v1/contracts/${contractId}/results?limit=1&order=asc`
  );
  const from = normalizeDeployer(executionDetail?.results?.[0]?.from ?? "");
  if (isMissing(from)) return metadata.deployerAddress;
  return from;
}

function buildClaudeReportPrompt(jobId, metadata, findings, severity, total, tags) {
  const findingSummary = findings
    .slice(0, 12)
    .map((finding) => {
      const agentId = normalizeText(finding?.agentId) || "unknown";
      const findingsCount = toNumber(finding?.findingsCount, 0);
      const criticalCount = toNumber(finding?.criticalCount, 0);
      const hash = normalizeText(finding?.findingsHash);
      return `- agent=${agentId}, findings=${findingsCount}, critical=${criticalCount}, hash=${hash || "n/a"}`;
    })
    .join("\n");

  return [
    `Job ID: ${jobId}`,
    `Contract Address: ${metadata.contractAddress}`,
    `Chain: ${metadata.contractChain}`,
    `Known Contract Type: ${metadata.contractType}`,
    `Known Deployer: ${metadata.deployerAddress}`,
    `Findings Total: ${total}`,
    `Severity Counts: critical=${severity.critical}, high=${severity.high}, medium=${severity.medium}, low=${severity.low}, info=${severity.info}`,
    `Tags: ${tags.length ? tags.join(", ") : "none"}`,
    `Finding Summary:\n${findingSummary || "- none"}`,
    "",
    "Return JSON only with this exact schema:",
    "{",
    '  "contractType": "lending|dex|staking|bridge|vault|unknown",',
    '  "riskNarrative": "One paragraph (90-160 words) covering multiple concern categories and prioritization. Do not invent addresses or claim certainty where evidence is weak."',
    "}",
  ].join("\n");
}

async function getClaudeReportEnrichment(jobId, metadata, findings, severity, total, tags) {
  if (!REPORT_CLAUDE_ENRICHMENT_ENABLED) return null;
  const apiKey = normalizeText(process.env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: resolveClaudeHaikuModel(),
      max_tokens: REPORT_CLAUDE_MAX_TOKENS,
      system:
        "You are a smart-contract security reviewer. Return strict JSON only and stay grounded to provided evidence.",
      messages: [
        {
          role: "user",
          content: buildClaudeReportPrompt(jobId, metadata, findings, severity, total, tags),
        },
      ],
    });

    const textBlock = response.content.find((block) => block?.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    return parseReportEnrichment(textBlock.text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[report-writer] Claude report enrichment failed for job ${jobId}: ${reason}`);
    return null;
  }
}

function formatMarkdown(jobId, job, findings, options = {}) {
  const sev = options.severity ?? calculateSeverity(findings);
  const total = totalFindings(findings);
  const agents = job.winners ?? [];
  const metadata = options.metadata ?? resolveMetadata(job, findings);
  const riskNarrative = normalizeText(options.riskNarrative);
  const reportDate = new Date().toISOString().split("T")[0];

  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${metadata.contractAddress}\`\n`;
  md += `**Chain:** ${metadata.contractChain}\n`;
  md += `**Deployer:** \`${metadata.deployerAddress}\`\n`;
  md += `**Contract Type:** ${metadata.contractType}\n`;
  md += `**Report Date:** ${reportDate}\n\n`;

  md += "## Executive Summary\n\n";
  md += `This audit identified **${total} finding${total === 1 ? "" : "s"}** `;
  md += `across ${agents.length} automated analysis agent${agents.length === 1 ? "" : "s"}.\n\n`;

  md += "## Severity Breakdown\n\n";
  md += `- Critical: ${sev.critical}\n`;
  md += `- High: ${sev.high}\n`;
  md += `- Medium: ${sev.medium}\n`;
  md += `- Low: ${sev.low}\n`;
  md += `- Info: ${sev.info}\n\n`;

  if (riskNarrative) {
    md += "## Risk Narrative\n\n";
    md += `${riskNarrative}\n\n`;
  }

  md += "## Agent Contributions\n\n";
  if (findings.length === 0) {
    md += "No findings were submitted by any agent.\n\n";
  } else {
    md += "| Agent | Findings | Critical | Hash |\n";
    md += "|-------|----------|----------|------|\n";
    for (const finding of findings) {
      const hash = finding?.findingsHash
        ? `\`${String(finding.findingsHash).slice(0, 12)}...\``
        : "—";
      md += `| ${finding?.agentId ?? "unknown"} | ${toNumber(finding?.findingsCount, 0)} | `;
      md += `${toNumber(finding?.criticalCount, 0)} | ${hash} |\n`;
    }
    md += "\n";
  }

  if (agents.length > 0) {
    md += "## Winning Agents\n\n";
    for (const addr of agents) {
      md += `- \`${addr}\`\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Generate and persist an audit report for a job.
 * For already-existing rows, allows updates when findings are available.
 *
 * @param {string|number} jobId
 * @param {Record<string, unknown>} job
 * @param {Array<Record<string, unknown>>} findings
 */
export async function generateAndStoreReport(jobId, job, findings) {
  const safeFindings = Array.isArray(findings) ? findings : [];
  const hasFindings = safeFindings.length > 0;
  const severity = calculateSeverity(safeFindings);
  const total = totalFindings(safeFindings);
  const tags = extractTags(safeFindings);
  const metadata = resolveMetadata(job, safeFindings);

  if (!hasFindings && (await reportExists(jobId))) {
    return;
  }

  metadata.deployerAddress = await hydrateDeployerFromMirror(metadata);

  const claude = await getClaudeReportEnrichment(
    String(jobId),
    metadata,
    safeFindings,
    severity,
    total,
    tags
  );
  if (isMissing(metadata.contractType) && !isMissing(claude?.contractType)) {
    metadata.contractType = normalizeContractTypeCandidate(claude.contractType);
  }

  const riskNarrative = normalizeText(claude?.riskNarrative) || buildBaselineNarrative(metadata, severity, total);

  const mdContent = formatMarkdown(jobId, job, safeFindings, {
    metadata,
    severity,
    riskNarrative,
  });
  const contentHash = crypto.createHash("sha3-256").update(mdContent).digest("hex");

  await saveReport({
    id: reportId(jobId),
    jobId: String(jobId),
    contractAddress: normalizeDeployer(metadata.contractAddress),
    deployerAddress: normalizeDeployer(metadata.deployerAddress),
    hederaAccountId: job.hederaAccountId ?? null,
    chain: metadata.contractChain,
    contractType: metadata.contractType,
    s3Key: "",
    contentHash,
    cid: job.cid ?? "",
    mdContent,
    agentAddresses: Array.isArray(job.winners) ? job.winners : [],
    agentCount: Array.isArray(job.winners) ? job.winners.length : 0,
    findingCount: total,
    findingsBySeverity: severity,
    timestamp: Date.now(),
    tags,
    source: "orchestrator",
  });
}
