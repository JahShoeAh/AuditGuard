import { AnimatePresence } from 'framer-motion';
import useStore from '../store/index';
import { useAgentLeaderboard } from '../hooks/useAgentLeaderboard';
import AgentLeaderboardRow from './AgentLeaderboardRow';
import AgentDetail from './AgentDetail';

// ── Empty state (right panel) ──────────────────────────────
function EmptyAgentDetail() {
  return (
    <div className="h-full flex items-center justify-center text-gray-600 text-sm font-mono text-center px-4">
      Select an agent from the leaderboard to view their iNFT profile.
    </div>
  );
}

// ── AgentLeaderboard ───────────────────────────────────────

export default function AgentLeaderboard() {
  const { agents, isLoading } = useAgentLeaderboard();
  const selectedAgent = useStore((s) => s.selectedAgent);
  const setSelectedAgent = useStore((s) => s.setSelectedAgent);
  const slashEvents = useStore((s) => s.slashEvents);

  // Build flash map: address → flash type based on recent log entries
  const recentSlashes = slashEvents.slice(0, 5);

  return (
    <div className="h-full flex gap-2 p-3 min-h-0">

      {/* ── Left 60%: Leaderboard ── */}
      <div className="w-[60%] flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2 flex-shrink-0">
          <span className="text-amber-400 text-lg">🏆</span>
          <h2 className="text-sm font-bold text-gray-100 uppercase tracking-widest font-mono">
            Agent Leaderboard
          </h2>
          <span className="ml-auto text-xs text-gray-500 font-mono">
            {agents.length} registered agents
            {isLoading && <span className="ml-1 text-cyan-400 animate-pulse">•</span>}
          </span>
        </div>

        {/* Column headers */}
        <div className="flex items-center gap-2 px-3 mb-1 text-[10px] font-bold text-gray-600 uppercase tracking-widest font-mono flex-shrink-0">
          <span className="w-5" />
          <span className="w-2" />
          <span className="flex-1">Agent</span>
          <span className="w-20 text-right">Tier</span>
          <span className="w-14 text-right">Rep</span>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {agents.length === 0 ? (
            <div className="text-gray-600 text-xs font-mono p-3">
              No agents registered yet — waiting for mock events...
            </div>
          ) : (
            <AnimatePresence>
              {agents.map((agent, i) => {
                const recentSlash = recentSlashes.find(
                  (e) => e.agent?.toLowerCase() === agent.address?.toLowerCase()
                );
                const isFlashing = recentSlash
                  ? 'slash'
                  : null;
                return (
                  <AgentLeaderboardRow
                    key={agent.address}
                    rank={i + 1}
                    profile={agent}
                    isSelected={selectedAgent === agent.address}
                    onSelect={setSelectedAgent}
                    isFlashing={isFlashing}
                  />
                );
              })}
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* ── Right 40%: Agent Detail ── */}
      <div className="flex-1 min-h-0 border border-gray-900 rounded bg-gray-900/60 overflow-hidden">
        {selectedAgent ? (
          <AgentDetail addr={selectedAgent} />
        ) : (
          <EmptyAgentDetail />
        )}
      </div>
    </div>
  );
}
