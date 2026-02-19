import type { ContractType, Finding, Severity } from "../shared/types.js";

export interface ParseResult {
  findings: Finding[];
  parseError?: string;
  rawResponse: string;
}

const VALID_SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const ID_PATTERN = /^LLM-\d{3}$/;

function extractJsonFromFence(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  return null;
}

function extractFirstJsonObject(raw: string): string | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) return match[0];
  return null;
}

function cleanTrailingCommas(json: string): string {
  return json.replace(/,\s*([\]}])/g, "$1");
}

function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(cleanTrailingCommas(text));
    } catch {
      return null;
    }
  }
}

function validateAndFixFinding(
  raw: any,
  index: number,
  agentId: string
): Finding | null {
  if (!raw || typeof raw !== "object") return null;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;

  let id = typeof raw.id === "string" ? raw.id : "";
  if (!ID_PATTERN.test(id)) {
    id = `LLM-${String(index + 1).padStart(3, "0")}`;
  }

  let severity: Severity = "medium";
  if (typeof raw.severity === "string" && VALID_SEVERITIES.includes(raw.severity as Severity)) {
    severity = raw.severity as Severity;
  }

  let confidence = typeof raw.confidence === "number" ? raw.confidence : 0.5;
  confidence = Math.max(0.0, Math.min(1.0, confidence));

  const description = typeof raw.description === "string" ? raw.description : "";

  return {
    id,
    severity,
    title,
    description,
    confidence,
    agentId,
    timestamp: Date.now(),
  };
}

export function parseFindings(
  raw: string,
  agentId: string,
  _contractType: ContractType
): ParseResult {
  if (!raw || !raw.trim()) {
    return { findings: [], parseError: "Empty response from LLM", rawResponse: raw };
  }

  let parsed: any = null;

  const fenced = extractJsonFromFence(raw);
  if (fenced) {
    parsed = tryParseJson(fenced);
  }

  if (!parsed) {
    parsed = tryParseJson(raw);
  }

  if (!parsed) {
    const extracted = extractFirstJsonObject(raw);
    if (extracted) {
      parsed = tryParseJson(extracted);
    }
  }

  if (!parsed) {
    return {
      findings: [],
      parseError: "Failed to parse JSON from LLM response",
      rawResponse: raw,
    };
  }

  if (!parsed.findings) {
    return {
      findings: [],
      parseError: "Response JSON missing 'findings' key",
      rawResponse: raw,
    };
  }

  if (!Array.isArray(parsed.findings)) {
    return {
      findings: [],
      parseError: "'findings' is not an array",
      rawResponse: raw,
    };
  }

  const findings: Finding[] = [];
  for (let i = 0; i < parsed.findings.length; i++) {
    const fixed = validateAndFixFinding(parsed.findings[i], i, agentId);
    if (fixed) findings.push(fixed);
  }

  return { findings, rawResponse: raw };
}
