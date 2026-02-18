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

  eligibleFor(contractType) {
    this.pruneStale();
    return [...this.agents.values()].filter((a) => {
      if ((a.stake ?? 0) < CONFIG.stakes.minStake) return false;
      if ((a.reputation ?? 0) < CONFIG.reputation.minReputation) return false;
      if (a.specializations && a.specializations.length && contractType) {
        return a.specializations.includes(contractType) || a.specializations.includes("any");
      }
      return true;
    });
  }
}
