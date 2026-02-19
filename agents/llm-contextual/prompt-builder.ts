import type { ContractType } from "../shared/types.js";
import type { ZGInferenceRequest } from "./zg-client.js";

export interface AuditContext {
  contractAddress: string;
  contractType: ContractType;
  estimatedLOC: number;
  riskScore: number;
  hasDepAnalysis: boolean;
  depAnalysisSummary?: string;
  contractSource?: string;
}

export function buildSystemPrompt(): string {
  return `You are an expert smart contract security auditor. Your task is to analyze a smart contract and identify security vulnerabilities.

You MUST respond with valid JSON only. No prose, no markdown outside of the JSON block.

Response format:
{
  "findings": [
    {
      "id": "LLM-001",
      "severity": "critical|high|medium|low|info",
      "title": "<concise vulnerability title>",
      "description": "<technical explanation of the vulnerability, its impact, and recommended fix>",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- severity must be one of: critical, high, medium, low, info
- confidence must be a number between 0.0 and 1.0
- id must follow the pattern LLM-001, LLM-002, etc.
- Return between 1 and 10 findings, prioritizing the most impactful vulnerabilities
- Focus on real, exploitable vulnerabilities rather than style issues`;
}

export function buildUserPrompt(ctx: AuditContext): string {
  let prompt = `Analyze the following smart contract for security vulnerabilities:

Contract Address: ${ctx.contractAddress}
Contract Type: ${ctx.contractType}
Estimated Lines of Code: ${ctx.estimatedLOC}
Risk Score: ${ctx.riskScore}/100`;

  if (ctx.hasDepAnalysis) {
    prompt += `\n\nDependency analysis has been performed on this contract.`;
    if (ctx.depAnalysisSummary) {
      prompt += ` Results:\n${ctx.depAnalysisSummary}`;
    }
    prompt += `\nIncorporate the dependency analysis insights into your vulnerability assessment.`;
  }

  if (ctx.contractSource) {
    prompt += `\n\nContract Source Code:\n\`\`\`solidity\n${ctx.contractSource}\n\`\`\`\n\nAnalyze the above Solidity source code. Identify ALL security vulnerabilities including: reentrancy, access control, arithmetic errors, oracle manipulation, front-running, unchecked return values. For each finding provide: Severity (CRITICAL/HIGH/MEDIUM/LOW/INFORMATIONAL), Title, Description, Location (function name), Recommendation.`;
  }

  prompt += `\n\nBased on the contract type "${ctx.contractType}" and risk score of ${ctx.riskScore}, identify the most likely vulnerabilities. Consider common attack vectors for ${ctx.contractType} contracts including reentrancy, oracle manipulation, access control issues, and economic exploits.`;

  return prompt;
}

export function buildMessages(
  ctx: AuditContext
): ZGInferenceRequest["messages"] {
  return [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(ctx) },
  ];
}
