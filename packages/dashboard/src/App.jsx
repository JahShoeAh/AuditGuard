import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { initializeConnection } from './services/hedera-connection';
import useStore from './store';

// Placeholder components — will be built in Prompts 3-4
function DiscoveryFeed() {
  return (
    <div className="panel p-4">
      <h2 className="text-guard-green text-sm font-semibold mb-2">DISCOVERY FEED</h2>
      <p className="text-gray-500 text-xs">Awaiting HCS subscription... (Prompt 3)</p>
    </div>
  );
}

function AuctionFeed() {
  return (
    <div className="panel p-4">
      <h2 className="text-guard-blue text-sm font-semibold mb-2">AUCTION FEED</h2>
      <p className="text-gray-500 text-xs">Awaiting event subscriptions... (Prompt 4)</p>
    </div>
  );
}

function AgentLeaderboard() {
  return (
    <div className="panel p-4">
      <h2 className="text-guard-purple text-sm font-semibold mb-2">AGENT LEADERBOARD</h2>
      <p className="text-gray-500 text-xs">Coming Day 2+</p>
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

// Debug panel showing config values
function DebugPanel({ config }) {
  if (!config) return null;

  const entries = [
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
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-500 uppercase tracking-wider text-[10px]">Config Debug</span>
        <span className="text-gray-600 text-[10px]">removable</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-gray-500">{label}</span>
            <span className="text-guard-green font-mono truncate">{String(value)}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

export default function App() {
  const { isConnected, connectionError, config, setConnected, setConnectionError } = useStore();
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const result = await initializeConnection();
        if (!cancelled) {
          setConnected(result.config, result.contracts, result.hederaClient, result.ethersProvider);
        }
      } catch (err) {
        console.error('[AuditGuard] Initialization failed:', err);
        if (!cancelled) {
          setConnectionError(err.message);
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [setConnected, setConnectionError]);

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
        <DebugPanel config={config} />
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
