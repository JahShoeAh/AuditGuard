export interface Finding {
  severity: string;
  title: string;
  description: string;
  location?: string;
  recommendation?: string;
}

export function formatReport(
  jobId: number | string,
  contractAddress: string,
  chain: string,
  contractType: string,
  auditorAgents: string[],
  findings: Finding[]
): string {
  const date = new Date().toISOString().split("T")[0];
  const sevIcon: Record<string, string> = {
    CRITICAL: "🔴",
    HIGH: "🟠",
    MEDIUM: "🟡",
    LOW: "🔵",
    INFORMATIONAL: "⚪",
  };
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  let md = "# Smart Contract Audit Report\n\n";
  md += "| Field | Value |\n|---|---|\n";
  md += `| **Contract** | \`${contractAddress}\` |\n`;
  md += `| **Chain** | ${chain} |\n`;
  md += `| **Type** | ${contractType} |\n`;
  md += `| **Date** | ${date} |\n`;
  md += `| **Job ID** | ${jobId} |\n`;
  md += `| **Auditor Agents** | ${auditorAgents.join(", ")} |\n\n`;

  md += "## Executive Summary\n\n";
  md += `This automated audit identified **${findings.length} findings**:\n\n`;
  for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"]) {
    if (counts[sev]) md += `- **${sev}**: ${counts[sev]}\n`;
  }
  if (counts.CRITICAL) md += `\n> ⚠️ **${counts.CRITICAL} critical** issues require immediate attention.\n`;
  md += "\n---\n\n## Findings\n\n";

  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  for (const f of sorted) {
    md += `### ${sevIcon[f.severity] || "⚪"} [${f.severity}] ${f.title}\n\n`;
    md += `${f.description}\n\n`;
    if (f.location) md += `**Location**: \`${f.location}\`\n\n`;
    if (f.recommendation) md += `**Recommendation**: ${f.recommendation}\n\n`;
    md += "---\n\n";
  }

  md += "## Disclaimer\n\nThis report was generated autonomously by AuditGuard's AI agent marketplace. Manual review is recommended for production deployments.\n";
  return md;
}

