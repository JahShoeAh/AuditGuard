import { CONFIG } from "./config.js";
import { now } from "../../agents/shared/types.js";

/**
 * Minimal in-memory roster with liveness and tiering.
 */
export class Roster {
  constructor(log) {
    this.log = log;
    this.agents = new Map(); // agentId -> { evmAddress, specializations, stake, reputation, tier, endpoint, lastSeen }
  }

  upsert(agent) {
    const existing = this.agents.get(agent.agentId) || {};
    const normalizedSpecializations = Array.isArray(agent.specializations) && agent.specializations.length
      ? agent.specializations.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : existing.specializations ?? [];
    const merged = {
      ...existing,
      ...agent,
      specializations: normalizedSpecializations,
      lastSeen: now(),
      tier: existing.tier ?? "COMMODITY",
    };
    this.agents.set(agent.agentId, merged);
    this.log.info(`Agent registered/updated: ${agent.agentId} stake=${agent.stake} rep=${agent.reputation ?? "?"}`);
  }

  get(agentId) {
    return this.agents.get(agentId) ?? null;
  }

  recordPong(agentId) {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.lastSeen = now();
  }

  pruneStale() {
    const cutoff = now() - CONFIG.timeouts.livenessExpiryMs;
    for (const [id, a] of this.agents.entries()) {
      if ((a.lastSeen ?? 0) < cutoff) {
        this.log.info(`Marking agent ${id} as stale`);
        this.agents.delete(id);
      }
    }
  }

  evaluateEligibility(contractType) {
    const cutoff = now() - CONFIG.timeouts.livenessExpiryMs;
    const normalizedType =
      typeof contractType === "string" ? contractType.trim().toLowerCase() : "";
    const canonicalTypes = new Set(["lending", "dex", "staking", "bridge", "vault"]);
    // Unknown/scheduled jobs should not be blocked by specialization labels.
    const enforceSpecializationMatch = canonicalTypes.has(normalizedType);
    const eligible = [];
    const excluded = [];
    const staleAgentIds = [];

    for (const [agentId, agent] of this.agents.entries()) {
      const reasons = [];
      if ((agent.lastSeen ?? 0) < cutoff) reasons.push("stale");
      if ((agent.stake ?? 0) < CONFIG.stakes.minStake) reasons.push("low_stake");
      if ((agent.reputation ?? 0) < CONFIG.reputation.minReputation) reasons.push("low_reputation");
      if (enforceSpecializationMatch && agent.specializations && agent.specializations.length) {
        const matches =
          agent.specializations.includes(normalizedType) ||
          agent.specializations.includes("any");
        if (!matches) reasons.push("specialization_mismatch");
      }

      if (reasons.length === 0) {
        eligible.push(agent);
      } else {
        excluded.push({
          agentId,
          evmAddress: agent.evmAddress,
          reasons,
        });
      }

      if (reasons.includes("stale")) staleAgentIds.push(agentId);
    }

    for (const staleId of staleAgentIds) {
      if (this.agents.has(staleId)) {
        this.log.info(`Marking agent ${staleId} as stale`);
        this.agents.delete(staleId);
      }
    }

    return { eligible, excluded };
  }

  eligibleFor(contractType) {
    return this.evaluateEligibility(contractType).eligible;
  }
}
