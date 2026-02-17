import { AnimatePresence, motion } from 'framer-motion';
import { useConnection } from './hooks/useConnection';
import { useEventListeners } from './hooks/useEventListeners';
import Header from './components/Header';
import DiscoveryFeed from './components/DiscoveryFeed';
import AuctionFeed from './components/AuctionFeed';
import ActivityLog from './components/ActivityLog';

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
