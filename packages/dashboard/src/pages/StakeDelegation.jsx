import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import Header from '../components/Header';
import DelegationPortfolio from '../components/stake/DelegationPortfolio';
import AgentBrowser from '../components/stake/AgentBrowser';
import DelegationWizard from '../components/stake/DelegationWizard';
import { ToastContainer } from '../components/ui/Toast';
import useWalletStore from '../store/wallet';
import WalletButton from '../components/wallet/WalletButton';

// ── Sub-header ─────────────────────────────────────────────

function StakeHeader({ hasPortfolio, connected }) {
  return (
    <div className="flex-shrink-0 flex items-center gap-4 px-5 py-3 border-b border-gray-800 bg-gray-950">
      {/* Back nav */}
      <Link
        to="/dashboard"
        className="flex items-center gap-1.5 text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors"
      >
        ← Dashboard
      </Link>

      <div className="h-4 w-px bg-gray-800" />

      <div className="flex items-center gap-2">
        <span className="text-amber-400 text-base">💎</span>
        <h1 className="text-sm font-bold font-mono uppercase tracking-widest text-gray-100">
          Delegate Stake
        </h1>
      </div>

      {connected && hasPortfolio && (
        <span className="text-[10px] font-mono text-gray-500">
          Back your favourite agents. Earn a share of their audit rewards.
        </span>
      )}

      <div className="ml-auto">
        <WalletButton />
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────

export default function StakeDelegation() {
  const [searchParams, setSearchParams] = useSearchParams();
  const connected  = useWalletStore((s) => s.connectionStatus === 'connected');

  // Pre-select agent from URL ?agent=0x…
  const [selectedAgent, setSelectedAgent] = useState(
    () => searchParams.get('agent') || null
  );

  // Keep URL in sync with selected agent
  useEffect(() => {
    if (selectedAgent) {
      setSearchParams({ agent: selectedAgent }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }, [selectedAgent, setSearchParams]);

  const handleSelectAgent = (addr) => setSelectedAgent(addr);
  const handleCloseWizard = ()    => setSelectedAgent(null);

  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-gray-100">
      {/* Top nav */}
      <Header />

      {/* Stake sub-header */}
      <StakeHeader hasPortfolio connected={connected} />

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-auto">

        {/* Portfolio section (only when connected) */}
        {connected && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.25 }}
            className="flex-shrink-0 px-4 pt-3"
          >
            <DelegationPortfolio onSelectAgent={handleSelectAgent} />
          </motion.div>
        )}

        {/* Agent browser + wizard split */}
        <div className="flex-1 flex gap-0 min-h-[500px] overflow-auto mt-3">

          {/* ── Left 55%: Agent Browser ── */}
          <div className="w-[55%] flex flex-col min-h-0 px-4 pb-4 border-r border-gray-800">
            <AgentBrowser
              selectedAgent={selectedAgent}
              onSelectAgent={handleSelectAgent}
            />
          </div>

          {/* ── Right 45%: Delegation Wizard ── */}
          <div className="flex-1 flex flex-col overflow-auto border-l border-gray-800 bg-gray-950">
            <DelegationWizard
              agentAddress={selectedAgent}
              onClose={handleCloseWizard}
              onSuccess={() => {
                // Optionally clear selection after success to show updated portfolio
              }}
            />
          </div>

        </div>
      </main>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}
