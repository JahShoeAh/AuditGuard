import { AnimatePresence, motion } from 'framer-motion';
import useStore from './store/index';
import { useConnection } from './hooks/useConnection';
import { useEventListeners } from './hooks/useEventListeners';
import Header from './components/Header';
import DiscoveryFeed from './components/DiscoveryFeed';
import AuctionFeed from './components/AuctionFeed';
import TransactionExplorer from './components/TransactionExplorer';
import MarketplacePanel from './components/MarketplacePanel';
import PaymentFlow from './components/PaymentFlow';
import DebugPanel from './components/DebugPanel';
import ActivityTicker from './components/ActivityTicker';
import AgentLeaderboard from './components/AgentLeaderboard';
import ContractHealth from './components/ContractHealth';

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

// ── Tab bar ────────────────────────────────────────────────

const TABS = [
  { key: 'liveFeed',  label: 'LIVE FEED',  icon: '◉' },
  { key: 'agents',    label: 'AGENTS',     icon: '👤' },
  { key: 'contracts', label: 'CONTRACTS',  icon: '🛡' },
  { key: 'analytics', label: 'ANALYTICS',  icon: '📊' },
];

function TabBar({ activeTab, onSelect }) {
  return (
    <div className="flex-shrink-0 flex items-center gap-1 px-3 border-b border-gray-800 bg-gray-950">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onSelect(tab.key)}
            className={[
              'flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold font-mono uppercase tracking-wider transition-all border-b-2',
              isActive
                ? 'text-gray-100 border-cyan-400'
                : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-gray-600',
            ].join(' ')}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Live Feed tab (Day 1+2 layout preserved) ───────────────

function LiveFeedTab() {
  return (
    <div className="h-full flex flex-col gap-2 p-3">
      {/* Main content — 3 columns */}
      <div className="flex-1 flex gap-2 min-h-0">
        <div className="xl:w-[25%] lg:w-[30%] w-full flex-shrink-0 min-h-0 hidden lg:block">
          <DiscoveryFeed />
        </div>
        <div className="xl:w-[45%] lg:flex-1 w-full flex-shrink-0 min-h-0">
          <AuctionFeed />
        </div>
        <div className="xl:flex-1 lg:w-[35%] w-full min-h-0 hidden xl:block">
          <MarketplacePanel />
        </div>
      </div>
      {/* Bottom strip */}
      <div className="h-[28vh] flex-shrink-0 flex gap-2">
        <div className="lg:w-[55%] w-full flex-shrink-0 min-h-0">
          <PaymentFlow />
        </div>
        <div className="flex-1 min-h-0 hidden lg:block">
          <TransactionExplorer />
        </div>
      </div>
    </div>
  );
}

// ── Analytics placeholder ──────────────────────────────────

function AnalyticsPlaceholder() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-600 font-mono">
      <div className="text-5xl">📊</div>
      <div className="text-sm font-bold uppercase tracking-widest text-gray-500">Analytics</div>
      <div className="text-xs text-gray-600">Network graph · Settlement timeline · Heatmaps</div>
      <div className="text-xs text-gray-700 mt-2">Coming in Prompts 3+4</div>
    </div>
  );
}

// ── Tab content wrapper ────────────────────────────────────

function TabContent({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}

// ── App ────────────────────────────────────────────────────

export default function App() {
  const connection = useConnection();
  const { connectionError } = connection;
  useEventListeners(connection);

  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100 overflow-hidden">
      {/* Header bar */}
      <Header />

      {/* Error banner */}
      <ErrorBanner message={connectionError} />

      {/* Tab bar */}
      <TabBar activeTab={activeTab} onSelect={setActiveTab} />

      {/* Tab content */}
      <main className="flex-1 overflow-hidden min-h-0">
        <AnimatePresence mode="wait">
          {activeTab === 'liveFeed' && (
            <TabContent key="liveFeed">
              <LiveFeedTab />
            </TabContent>
          )}
          {activeTab === 'agents' && (
            <TabContent key="agents">
              <AgentLeaderboard />
            </TabContent>
          )}
          {activeTab === 'contracts' && (
            <TabContent key="contracts">
              <ContractHealth />
            </TabContent>
          )}
          {activeTab === 'analytics' && (
            <TabContent key="analytics">
              <AnalyticsPlaceholder />
            </TabContent>
          )}
        </AnimatePresence>
      </main>

      {/* Activity ticker — always visible */}
      <ActivityTicker />

      {/* Debug panel — toggle with Ctrl+D */}
      <DebugPanel />
    </div>
  );
}
