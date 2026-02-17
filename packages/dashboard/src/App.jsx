import { AnimatePresence, motion } from 'framer-motion';
import { useConnection } from './hooks/useConnection';
import { useEventListeners } from './hooks/useEventListeners';
import Header from './components/Header';
import DiscoveryFeed from './components/DiscoveryFeed';
import AuctionFeed from './components/AuctionFeed';
import TransactionExplorer from './components/TransactionExplorer';
import MarketplacePanel from './components/MarketplacePanel';
import PaymentFlow from './components/PaymentFlow';
import DebugPanel from './components/DebugPanel';

// ── Connection error banner ────────────────────────────────

function ErrorBanner({ message }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="flex-shrink-0 panel px-4 py-2 text-xs text-guard-red font-mono"
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
    <div className="h-screen flex flex-col p-3 gap-2 overflow-hidden">
      {/* Header bar */}
      <Header />

      {/* Error banner (if any) */}
      <ErrorBanner message={connectionError} />

      {/*
        Responsive main content:
        xl+: 3 columns — Discovery (25%) | Auction (45%) | Marketplace (30%)
        lg:  2 columns — Discovery+Auction stacked left (60%) | Marketplace (40%)
        <lg: single column, full-width panels
      */}
      <div className="flex-1 flex gap-2 min-h-0">
        {/* Left — Discovery Feed */}
        <div className="xl:w-[25%] lg:w-[30%] w-full flex-shrink-0 min-h-0 hidden lg:block">
          <DiscoveryFeed />
        </div>

        {/* Center — Auction Feed */}
        <div className="xl:w-[45%] lg:flex-1 w-full flex-shrink-0 min-h-0">
          <AuctionFeed />
        </div>

        {/* Right — Data Marketplace */}
        <div className="xl:flex-1 lg:w-[35%] w-full min-h-0 hidden xl:block">
          <MarketplacePanel />
        </div>
      </div>

      {/* Bottom strip: GUARD Flow (55%) | Tx Explorer (45%) */}
      <div className="h-[28vh] flex-shrink-0 flex gap-2">
        <div className="lg:w-[55%] w-full flex-shrink-0 min-h-0">
          <PaymentFlow />
        </div>
        <div className="flex-1 min-h-0 hidden lg:block">
          <TransactionExplorer />
        </div>
      </div>

      {/* Debug panel — toggle with Ctrl+D */}
      <DebugPanel />
    </div>
  );
}
