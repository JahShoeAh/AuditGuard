import { AnimatePresence, motion } from 'framer-motion';
import { useConnection } from './hooks/useConnection';
import { useEventListeners } from './hooks/useEventListeners';
import useStore from './store';
import Header from './components/Header';
import DiscoveryFeed from './components/DiscoveryFeed';
import ActivityLog from './components/ActivityLog';

// ── Auction Feed placeholder (Prompt 4) ────────────────────

function AuctionFeed() {
  const jobCount = useStore((s) => Object.keys(s.activeJobs).length);
  const bidCount = useStore((s) => s.stats.totalBids);

  return (
    <div className="panel flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center gap-2 flex-shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-guard-amber animate-pulse-glow" />
        <h2 className="text-xs font-semibold tracking-wider uppercase font-sans text-guard-amber">
          Auction Feed
        </h2>
        <span className="text-[10px] text-gray-600 font-mono">
          ({jobCount} jobs, {bidCount} bids)
        </span>
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-xs text-gray-500 font-sans mb-1">Real-time auction activity</p>
          <p className="text-[10px] text-gray-600 font-mono">Coming in Prompt 4</p>
        </div>
      </div>
    </div>
  );
}

// ── Connection error banner ────────────────────────────────

function ErrorBanner({ message }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mb-2 panel px-4 py-2 text-xs text-guard-red font-mono"
          style={{ borderColor: 'rgba(239, 68, 68, 0.2)' }}
        >
          Connection error: {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── App ────────────────────────────────────────────────────

export default function App() {
  const connection = useConnection();
  const { connectionError } = connection;

  // Start event listeners (mock or live)
  useEventListeners(connection);

  return (
    <div className="h-screen flex flex-col p-3 gap-3 overflow-hidden">
      {/* Header bar */}
      <Header />

      {/* Error banner (if any) */}
      <ErrorBanner message={connectionError} />

      {/* Main content: Discovery (45%) | Auction (55%) */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Left — Discovery Feed */}
        <div className="w-[45%] flex-shrink-0 min-h-0">
          <DiscoveryFeed />
        </div>

        {/* Right — Auction Feed */}
        <div className="flex-1 min-h-0">
          <AuctionFeed />
        </div>
      </div>

      {/* Bottom — Activity Log (25% of viewport) */}
      <div className="h-[25vh] flex-shrink-0">
        <ActivityLog />
      </div>
    </div>
  );
}
