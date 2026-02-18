import { useState, useEffect } from 'react';
import useStore from '../store/index';

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
  const contracts        = useStore((s) => s.contracts);
  const useMockEvents    = useStore((s) => s.useMockEvents);

  const [enrichedAgents, setEnrichedAgents] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // Rebuild enriched list whenever any source changes
  useEffect(() => {
    const combined = Object.entries(agents).map(([addr, reg]) => ({
      address: addr,
      ...reg,
      ...(agentProfiles[addr] || {}),
      history: reputationHistory[addr] || [],
    }));
    setEnrichedAgents(
      combined.sort((a, b) => (b.reputationScore || b.reputation || 0) - (a.reputationScore || a.reputation || 0))
    );
  }, [agents, agentProfiles, reputationHistory]);

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
