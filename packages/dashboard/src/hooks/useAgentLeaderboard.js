import { useState, useEffect } from 'react';
import useStore from '../store/index';

function addrKey(value) {
  if (!value) return '';
  return String(value).toLowerCase();
}

/**
 * Builds a sorted enriched agent list for the leaderboard.
 * Merges store.agents (from AgentRegistered events / mock data)
 * with store.agentProfiles (from StakingManager contract reads)
 * and store.reputationHistory (from reputation snapshots).
 *
 * When a live connection is available, also polls StakingManager
 * and Treasury every 15s to populate stake health + discount data.
 */
export function useAgentLeaderboard() {
  const agents           = useStore((s) => s.agents);
  const agentProfiles    = useStore((s) => s.agentProfiles);
  const reputationHistory = useStore((s) => s.reputationHistory);
  const bids             = useStore((s) => s.bids);
  const winners          = useStore((s) => s.winners);
  const auditLog         = useStore((s) => s.auditLog);
  const slashEvents      = useStore((s) => s.slashEvents);
  const contracts        = useStore((s) => s.contracts);
  const config           = useStore((s) => s.config);
  const useMockEvents    = useStore((s) => s.useMockEvents);

  const [enrichedAgents, setEnrichedAgents] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // Rebuild enriched list whenever any source changes
  useEffect(() => {
    const knownAgentIds = {};
    for (const [addr, profile] of Object.entries(agents)) {
      const id = String(profile?.agentId || '').toLowerCase();
      if (id) knownAgentIds[id] = addr;
    }
    const seededAgents = config?.seededAgents || {};
    for (const [seedName, seedInfo] of Object.entries(seededAgents)) {
      const candidateAddr = addrKey(seedInfo?.evmAddress);
      if (!candidateAddr) continue;
      const keyByName = String(seedName || '').toLowerCase();
      const keyById = String(seedInfo?.agentId || '').toLowerCase();
      if (keyByName) knownAgentIds[keyByName] = candidateAddr;
      if (keyById) knownAgentIds[keyById] = candidateAddr;
    }

    const bidCounts = {};
    const winCounts = {};
    const findingCounts = {};
    const slashCounts = {};
    const falsePositiveCounts = {};

    for (const [jobId, jobBids] of Object.entries(bids || {})) {
      const winnerSet = new Set((winners?.[jobId]?.agents || []).map((a) => addrKey(a)));
      for (const bid of jobBids || []) {
        const addr = addrKey(bid.agent || bid.evmAddress);
        if (!addr) continue;
        bidCounts[addr] = (bidCounts[addr] || 0) + 1;
        if (winnerSet.has(addr)) {
          winCounts[addr] = (winCounts[addr] || 0) + 1;
        }
      }
    }

    for (const slash of slashEvents || []) {
      const addr = addrKey(slash.agent);
      if (!addr) continue;
      slashCounts[addr] = (slashCounts[addr] || 0) + 1;
      const reason = String(slash.reasonStr || '').toLowerCase();
      if (reason.includes('false_positive') || Number(slash.reason) === 0) {
        falsePositiveCounts[addr] = (falsePositiveCounts[addr] || 0) + 1;
      }
    }

    for (const entry of auditLog || []) {
      const type = String(entry.type || '').toUpperCase();
      if (type !== 'FINDINGS_SUBMITTED') continue;
      const payload = entry.payload || {};
      const agentId = String(entry.agentId || payload.agentId || '').toLowerCase();
      const evm = addrKey(
        payload.evmAddress ||
        payload.agentAddress ||
        payload.address ||
        entry.evmAddress ||
        entry.agentAddress ||
        entry.address
      );
      const addr = evm || (agentId ? knownAgentIds[agentId] : '');
      if (!addr) continue;

      let findingCount = Number(
        payload.findingCount ??
        payload.findingsCount ??
        entry.findingCount ??
        entry.findingsCount ??
        0
      );
      if ((!Number.isFinite(findingCount) || findingCount <= 0) && Array.isArray(payload.findings)) {
        findingCount = payload.findings.length;
      }
      if ((!Number.isFinite(findingCount) || findingCount <= 0) && Array.isArray(entry.findings)) {
        findingCount = entry.findings.length;
      }
      if (!Number.isFinite(findingCount) || findingCount < 0) findingCount = 0;
      if (findingCount === 0) findingCount = 1;
      findingCounts[addr] = (findingCounts[addr] || 0) + findingCount;
    }

    const combined = Object.entries(agents).map(([addr, reg]) => ({
      address: addr,
      ...reg,
      ...(agentProfiles[addr] || {}),
      history: reputationHistory[addr] || [],
      completedJobs: winCounts[addrKey(addr)] || reg.completedJobs || 0,
      successfulFindings: findingCounts[addrKey(addr)] || reg.successfulFindings || 0,
      falsePositives: falsePositiveCounts[addrKey(addr)] || reg.falsePositives || 0,
      slashCount: slashCounts[addrKey(addr)] || reg.slashCount || 0,
      bidsPlaced: bidCounts[addrKey(addr)] || reg.bidsPlaced || 0,
      winRate: (bidCounts[addrKey(addr)] || 0) > 0
        ? ((winCounts[addrKey(addr)] || 0) / bidCounts[addrKey(addr)]) * 100
        : (reg.winRate || 0),
    }));
    setEnrichedAgents(
      combined.sort((a, b) => (b.reputationScore || b.reputation || 0) - (a.reputationScore || a.reputation || 0))
    );
  }, [agents, agentProfiles, reputationHistory, bids, winners, auditLog, slashEvents, config]);

  // Poll StakingManager + Treasury when live (not mock mode)
  useEffect(() => {
    if (useMockEvents) return;
    if (!contracts?.stakingManagerContract || !contracts?.treasuryContract) return;

    const poll = async () => {
      setIsLoading(true);
      const addrs = Object.keys(agents);
      for (const addr of addrs) {
        try {
          const [effectiveStake, slashCount, totalSlashed, hasActiveAppeals, status] =
            await contracts.stakingManagerContract.getAgentStakeHealth(addr);
          const [eligible, currentStake, currentReputation] =
            await contracts.treasuryContract.getDiscountEligibility(addr);
          useStore.getState().setAgentProfile(addr, {
            effectiveStake: effectiveStake.toString(),
            slashCount: Number(slashCount),
            totalSlashed: totalSlashed.toString(),
            hasActiveAppeals,
            stakeStatus: ['ACTIVE', 'UNBONDING', 'WITHDRAWN', 'FROZEN'][Number(status)] || 'ACTIVE',
            discount: {
              eligible,
              currentStake: currentStake.toString(),
              currentReputation: currentReputation.toString(),
            },
          });
        } catch {
          // Agent may not be in StakingManager yet — skip silently
        }
      }
      setIsLoading(false);
    };

    const id = setInterval(poll, 15_000);
    poll();
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, useMockEvents, Object.keys(agents).join(',')]);

  return { agents: enrichedAgents, isLoading };
}
