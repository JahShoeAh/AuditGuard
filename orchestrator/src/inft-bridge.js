import { createRequire } from "module";

/**
 * Thin bridge to the existing INFTService (CommonJS) for reputation updates.
 * Uses a simple agentId -> serialNumber map provided via AGENT_SERIALS_JSON env var.
 * If mapping or credentials are missing, calls are no-ops.
 */
export class InftBridge {
  constructor() {
    this.require = createRequire(import.meta.url);
    this.agentSerials = safeParseMap(process.env.AGENT_SERIALS_JSON);
    this.service = null;
    this.jobSerials = safeParseMap(process.env.JOB_SERIALS_JSON); // optional jobId -> serial map
  }

  ensureService() {
    if (this.service) return this.service;
    const accountId = process.env.OPERATOR_ACCOUNT_ID;
    const privateKey = process.env.OPERATOR_PRIVATE_KEY;
    if (!accountId || !privateKey) return null;
    try {
      const { INFTService } = this.require("../../packages/inft/src/inft-service.js");
      const { StorageAdapter } = this.require("../../packages/inft/src/storage-0g.js");
      this.service = new INFTService({
        operatorId: accountId,
        operatorKey: privateKey,
        storage: new StorageAdapter(),
      });
      return this.service;
    } catch (err) {
      console.warn("[inft] failed to init INFTService:", err.message);
      return null;
    }
  }

  async updateReputation(agentId, deltaBasisPoints, jobId) {
    const serial = this.agentSerials?.[agentId];
    if (!serial) return false;
    const svc = this.ensureService();
    if (!svc) return false;
    try {
      await svc.updateAgentReputation(serial, deltaBasisPoints, "report_score", jobId);
      return true;
    } catch (err) {
      console.warn(`[inft] updateAgentReputation failed for ${agentId}: ${err.message}`);
      return false;
    }
  }

  async markJobCompleted(jobId, txHash) {
    const serial = this.jobSerials?.[jobId];
    if (!serial) return false;
    const svc = this.ensureService();
    if (!svc) return false;
    try {
      await svc.transitionAuditJobState(serial, "COMPLETED", "PaymentSettlement.JobSettled", txHash);
      return true;
    } catch (err) {
      console.warn(`[inft] transitionAuditJobState failed for job ${jobId}: ${err.message}`);
      return false;
    }
  }
}

function safeParseMap(json) {
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}
