"use strict";

/**
 * @typedef {Object} Finding
 * @property {string} id
 * @property {"critical"|"high"|"medium"|"low"|"info"} severity
 * @property {string} title
 * @property {string} description
 * @property {number} confidence
 * @property {string} agentId
 * @property {number} timestamp
 */

/**
 * Map Slither/Aderyn/Semgrep impact strings to AuditGuard severity levels.
 * @param {string} impact
 * @returns {"critical"|"high"|"medium"|"low"|"info"}
 */
function mapImpactToSeverity(impact) {
  const lower = (impact ?? "").toLowerCase();
  if (lower === "high" || lower.includes("reentrancy") || lower.includes("reentrant")) return "high";
  if (lower === "medium" || lower.includes("overflow") || lower.includes("underflow")) return "medium";
  if (lower === "low") return "low";
  if (lower === "informational" || lower === "info" || lower === "optimization") return "info";
  if (lower.includes("critical") || lower.includes("selfdestruct") || lower.includes("delegatecall")) return "critical";
  return "medium";
}

/**
 * Normalize a Slither impact+confidence pair to AuditGuard severity.
 * Slither's "High" impact with "High" confidence → "high"
 * Slither's "High" impact with "Low" confidence  → "medium" (downgrade)
 * @param {string} impact
 * @param {string} [confidence]
 * @returns {"critical"|"high"|"medium"|"low"|"info"}
 */
function mapSlitherSeverity(impact, confidence) {
  const sev = mapImpactToSeverity(impact);
  // Downgrade if confidence is low
  if (confidence && confidence.toLowerCase() === "low") {
    if (sev === "critical") return "high";
    if (sev === "high") return "medium";
  }
  return sev;
}

module.exports = { mapImpactToSeverity, mapSlitherSeverity };
