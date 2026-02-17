import { motion, AnimatePresence } from 'framer-motion';
import { useConnection } from './hooks/useConnection';
import { useEventListeners } from './hooks/useEventListeners';
import useStore from './store';

// Placeholder components — will be built in Prompts 3-4
function DiscoveryFeed() {
  const count = useStore((s) => s.discoveries.length);
  return (
    <div className="panel p-4">
      <h2 className="text-guard-green text-sm font-semibold mb-2">DISCOVERY FEED</h2>
      <p className="text-gray-500 text-xs">
        {count > 0
          ? `${count} contracts discovered — UI coming in Prompt 3`
          : 'Awaiting HCS subscription... (Prompt 3)'}
      </p>
    </div>
  );
}

function AuctionFeed() {
  const jobCount = useStore((s) => Object.keys(s.activeJobs).length);
  return (
    <div className="panel p-4">
      <h2 className="text-guard-blue text-sm font-semibold mb-2">AUCTION FEED</h2>
      <p className="text-gray-500 text-xs">
        {jobCount > 0
          ? `${jobCount} active jobs — UI coming in Prompt 4`
          : 'Awaiting event subscriptions... (Prompt 4)'}
      </p>
    </div>
  );
}

function AgentLeaderboard() {
  const agentCount = useStore((s) => Object.keys(s.agents).length);
  return (
    <div className="panel p-4">
      <h2 className="text-guard-purple text-sm font-semibold mb-2">AGENT LEADERBOARD</h2>
      <p className="text-gray-500 text-xs">
        {agentCount > 0 ? `${agentCount} agents tracked` : 'Coming Day 2+'}
      </p>
    </div>
  );
}

// Connection status indicator
function StatusDot({ connected, error }) {
  return (
    <div className="flex items-center gap-2">
      <span className={connected ? 'status-dot-connected' : 'status-dot-disconnected'} />
      <span className="text-xs text-gray-400">
        {connected ? 'CONNECTED' : error ? 'ERROR' : 'CONNECTING...'}
      </span>
    </div>
  );
}

// Debug panel — config values + live event counters + mock toggle
function DebugPanel({ config, connection }) {
  const stats = useStore((s) => s.stats);
  const discoveries = useStore((s) => s.discoveries.length);
  const auditLog = useStore((s) => s.auditLog.length);
  const useMockEvents = useStore((s) => s.useMockEvents);
  const toggleMock = useStore((s) => s.toggleMockEvents);

  if (!config) return null;

  const totalEvents = discoveries + auditLog;

  const configEntries = [
    ['GUARD Token', config.guardTokenId],
    ['AuditAuction', config.contracts?.auctionContract?.evmAddress],
    ['HCS Discovery', config.hcsTopics?.discovery],
    ['Seeded Agents', Object.keys(config.seededAgents || {}).length || 'N/A'],
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="panel p-3 text-xs"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-gray-500 uppercase tracking-wider text-[10px]">Config Debug</span>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-gray-500 text-[10px]">Mock Events</span>
          <div className="relative">
            <input
              type="checkbox"
              checked={useMockEvents}
              onChange={toggleMock}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-guard-border rounded-full peer-checked:bg-guard-green/40 transition-colors" />
            <div className="absolute top-0.5 left-0.5 w-3 h-3 bg-gray-400 rounded-full peer-checked:translate-x-4 peer-checked:bg-guard-green transition-all" />
          </div>
        </label>
      </div>

      {/* Config values */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3">
        {configEntries.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-gray-500">{label}</span>
            <span className="text-guard-green font-mono truncate">{String(value)}</span>
          </div>
        ))}
      </div>

      {/* Divider */}
      <div className="border-t border-guard-border my-2" />

      {/* Live event counters */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-gray-500 uppercase tracking-wider text-[10px]">Live Counters</span>
        <span className="text-guard-green text-[10px] font-semibold">
          Events received: {totalEvents}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2 mt-1">
        <CounterChip label="Discoveries" value={stats.totalDiscoveries} color="text-guard-green" />
        <CounterChip label="Auctions" value={stats.totalAuctions} color="text-guard-blue" />
        <CounterChip label="Bids" value={stats.totalBids} color="text-guard-yellow" />
        <CounterChip label="Log Entries" value={auditLog} color="text-guard-purple" />
      </div>
    </motion.div>
  );
}

function CounterChip({ label, value, color }) {
  return (
    <div className="bg-guard-dark rounded px-2 py-1 text-center">
      <div className={`text-sm font-bold ${color}`}>{value}</div>
      <div className="text-[9px] text-gray-600 uppercase">{label}</div>
    </div>
  );
}

export default function App() {
  const connection = useConnection();
  const { isConnected, connectionError, config } = connection;

  // Start event listeners (mock or live depending on store toggle)
  useEventListeners(connection);

  return (
    <div className="min-h-screen p-4 max-w-7xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">
            <span className="text-guard-green glow-text">AUDIT</span>
            <span className="text-gray-300">GUARD</span>
          </h1>
          <span className="text-[10px] text-gray-600 uppercase tracking-widest border border-guard-border px-2 py-0.5 rounded">
            Agent Marketplace
          </span>
        </div>
        <StatusDot connected={isConnected} error={connectionError} />
      </header>

      {/* Connection error banner */}
      <AnimatePresence>
        {connectionError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-4 panel border-guard-red/30 bg-guard-red/5 p-3 text-xs text-guard-red"
          >
            Connection error: {connectionError}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Debug panel */}
      <div className="mb-6">
        <DebugPanel config={config} connection={connection} />
      </div>

      {/* Main grid — placeholder slots */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <DiscoveryFeed />
          <AuctionFeed />
        </div>
        <div>
          <AgentLeaderboard />
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-8 text-center text-[10px] text-gray-700">
        AuditGuard v0.1 — Autonomous Agent Marketplace — Hedera Testnet
      </footer>
    </div>
  );
}
