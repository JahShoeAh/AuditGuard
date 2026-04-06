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
 * Map ItyFuzz/Mythril bug type strings to AuditGuard severity levels.
 * @param {string} bugType
 * @returns {"critical"|"high"|"medium"|"low"|"info"}
 */
function mapBugTypeToSeverity(bugType) {
  const lower = bugType.toLowerCase();
  if (lower.includes("reentrancy") || lower.includes("reentrant")) return "critical";
  if (lower.includes("overflow") || lower.includes("underflow")) return "high";
  if (lower.includes("access") || lower.includes("auth") || lower.includes("privilege")) return "high";
  if (lower.includes("delegatecall") || lower.includes("selfdestruct")) return "critical";
  if (lower.includes("integer")) return "high";
  if (lower.includes("unchecked")) return "medium";
  if (lower.includes("tx.origin")) return "medium";
  if (lower.includes("timestamp")) return "low";
  if (lower.includes("gas") || lower.includes("dos")) return "medium";
  return "medium";
}

module.exports = { mapBugTypeToSeverity };
