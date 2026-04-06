import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import useStore from './store/index';
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
import AuditJobTracker from './components/AuditJobTracker';
import ReputationComparison from './components/ReputationComparison';
import NetworkGraph from './components/NetworkGraph';
import SettlementTimeline from './components/SettlementTimeline';
import TreasuryEconomics from './components/TreasuryEconomics';
import StoryMode from './components/StoryMode';
import CompetitionHeatmap from './components/CompetitionHeatmap';
import AuditSchedules from './components/AuditSchedules';
import VaultPanel from './components/VaultPanel';
import ExchangeWidget from './components/ExchangeWidget';

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

function HydrationBanner({ status, error }) {
  const show = status === 'failed' || status === 'degraded';
  if (!show) return null;
  const prefix = status === 'failed'
    ? 'On-chain agents unavailable'
    : 'On-chain agent hydration is degraded';
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="flex-shrink-0 panel px-4 py-2 text-xs text-guard-amber font-mono"
        style={{ borderColor: 'rgba(245, 158, 11, 0.2)' }}
      >
        {prefix}{error ? `: ${error}` : ''}
      </motion.div>
    </AnimatePresence>
  );
}

const TABS = [
  { key: 'liveFeed', label: 'LIVE FEED', icon: '◉' },
  { key: 'agents', label: 'AGENTS', icon: '👤' },
  { key: 'contracts', label: 'CONTRACTS', icon: '🛡' },
  { key: 'analytics', label: 'ANALYTICS', icon: '📊' },
  { key: 'schedules', label: 'SCHEDULES', icon: '⏱' },
];

function TabBar({ activeTab, onSelect }) {
  return (
    <div className="flex items-center gap-1 px-3">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onSelect(tab.key)}
            className={[
              'flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold font-mono uppercase tracking-wider transition-all border-b-2',
              isActive
                ? 'text-gray-100 border-guard-amber'
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

function LiveFeedTab() {
  return (
    <div className="h-full flex flex-col gap-2 p-3">
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

function AgentsTab() {
  const [showComparison, setShowComparison] = useState(false);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-gray-800 flex items-center justify-end bg-gray-950">
        <button
          onClick={() => setShowComparison((v) => !v)}
          className={[
            'text-[10px] font-bold uppercase tracking-wider font-mono px-3 py-1 rounded transition-colors',
            showComparison
              ? 'bg-cyan-900 text-cyan-300 border border-cyan-700'
              : 'bg-gray-800 text-gray-500 hover:text-gray-300 border border-gray-700',
          ].join(' ')}
        >
          📈 Compare Agents
        </button>
      </div>

      <AnimatePresence initial={false}>
        {showComparison && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="flex-shrink-0 overflow-hidden border-b border-gray-800 bg-gray-950 px-3 py-2"
          >
            <ReputationComparison />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 min-h-0 overflow-auto">
        <AgentLeaderboard />
      </div>
    </div>
  );
}

function ContractsTab() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-auto">
        <ContractHealth />
      </div>
      <AuditJobTracker />
    </div>
  );
}

const SCHEDULES_SUB_TABS = [
  { key: 'schedules', label: 'Schedules', icon: '⏱' },
  { key: 'vaults',    label: 'Vaults',    icon: '🏦' },
  { key: 'exchange',  label: 'Exchange',  icon: '⚡' },
];

function SchedulesTab() {
  const [subTab, setSubTab] = useState('schedules');

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 bg-gray-950">
        {SCHEDULES_SUB_TABS.map((tab) => {
          const isActive = subTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              className={[
                'flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-bold font-mono uppercase tracking-wider transition-colors',
                isActive
                  ? 'bg-gray-800 text-cyan-300 border border-gray-700'
                  : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
            >
              <span className="text-[10px]">{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {subTab === 'schedules' && <AuditSchedules />}
        {subTab === 'vaults'    && <VaultPanel />}
        {subTab === 'exchange'  && <ExchangeWidget />}
      </div>
    </div>
  );
}

const ANALYTICS_TABS = [
  { key: 'network', label: 'Network Graph', icon: '◈' },
  { key: 'timeline', label: 'Settlement Timeline', icon: '▬' },
  { key: 'competition', label: 'Competition Map', icon: '⬡' },
];

function AnalyticsTab() {
  const [subTab, setSubTab] = useState('network');

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 bg-gray-950">
        {ANALYTICS_TABS.map((tab) => {
          const isActive = subTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              className={[
                'flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-bold font-mono uppercase tracking-wider transition-colors',
                isActive
                  ? 'bg-gray-800 text-cyan-300 border border-gray-700'
                  : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
            >
              <span className="text-[10px]">{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {subTab === 'network' && (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0">
              <NetworkGraph />
            </div>
          </div>
        )}
        {subTab === 'timeline' && (
          <div className="h-full flex flex-col min-h-0 overflow-auto">
            <SettlementTimeline />
            <div className="flex-shrink-0 border-t border-gray-800">
              <TreasuryEconomics />
            </div>
          </div>
        )}
        {subTab === 'competition' && <CompetitionHeatmap />}
      </div>
    </div>
  );
}

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

export default function Dashboard() {
  const connectionError = useStore((s) => s.connectionError);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const agentHydrationStatus = useStore((s) => s.ingestionHealth?.agentHydrationStatus);
  const agentHydrationError = useStore((s) => s.ingestionHealth?.agentHydrationError);
  const [storyMode, setStoryMode] = useState(false);

  return (
    <div className="h-screen flex flex-col bg-black text-gray-100 overflow-hidden">
      <Header />

      <StoryMode
        isActive={storyMode}
        onClose={() => setStoryMode(false)}
        onTabSwitch={setActiveTab}
      />

      <ErrorBanner message={connectionError} />
      <HydrationBanner status={agentHydrationStatus} error={agentHydrationError} />

      <div className="flex-shrink-0 flex items-center border-b border-gray-900 bg-black">
        <TabBar activeTab={activeTab} onSelect={setActiveTab} />
        <div className="ml-auto pr-3">
          <button
            onClick={() => setStoryMode((v) => !v)}
            className={[
              'text-[10px] font-bold font-mono uppercase tracking-wider px-3 py-1.5 rounded transition-colors border',
              storyMode
                ? 'bg-cyan-900 text-cyan-300 border-cyan-700'
                : 'bg-gray-800 text-gray-500 hover:text-gray-300 border-gray-700',
            ].join(' ')}
          >
            {storyMode ? 'EXIT STORY' : 'STORY MODE'}
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-auto min-h-0">
        <AnimatePresence mode="wait">
          {activeTab === 'liveFeed' && (
            <TabContent key="liveFeed">
              <LiveFeedTab />
            </TabContent>
          )}
          {activeTab === 'agents' && (
            <TabContent key="agents">
              <AgentsTab />
            </TabContent>
          )}
          {activeTab === 'contracts' && (
            <TabContent key="contracts">
              <ContractsTab />
            </TabContent>
          )}
          {activeTab === 'analytics' && (
            <TabContent key="analytics">
              <AnalyticsTab />
            </TabContent>
          )}
          {activeTab === 'schedules' && (
            <TabContent key="schedules">
              <SchedulesTab />
            </TabContent>
          )}
        </AnimatePresence>
      </main>

      <ActivityTicker />
      <DebugPanel />
    </div>
  );
}
