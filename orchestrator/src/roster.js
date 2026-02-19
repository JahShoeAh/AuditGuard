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
    const merged = { ...existing, ...agent, lastSeen: now(), tier: existing.tier ?? "COMMODITY" };
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
    const eligible = [];
    const excluded = [];
    const staleAgentIds = [];

    for (const [agentId, agent] of this.agents.entries()) {
      const reasons = [];
      if ((agent.lastSeen ?? 0) < cutoff) reasons.push("stale");
      if ((agent.stake ?? 0) < CONFIG.stakes.minStake) reasons.push("low_stake");
      if ((agent.reputation ?? 0) < CONFIG.reputation.minReputation) reasons.push("low_reputation");
      if (agent.specializations && agent.specializations.length && contractType) {
        const matches =
          agent.specializations.includes(contractType) ||
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
