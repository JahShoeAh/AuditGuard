import { AnimatePresence } from 'framer-motion';
import useStore from '../store/index';
import { useContractHealth } from '../hooks/useContractHealth';
import ContractHealthCard from './ContractHealthCard';
import VaultDetail from './VaultDetail';

// ── Empty state ────────────────────────────────────────────
function EmptyVaultDetail() {
  return (
    <div className="h-full flex items-center justify-center text-gray-600 text-sm font-mono text-center px-4">
      Select a contract to view its health iNFT.
    </div>
  );
}

// ── ContractHealth ─────────────────────────────────────────

export default function ContractHealth() {
  const { contracts } = useContractHealth();
  const selectedContract = useStore((s) => s.selectedContract);
  const setSelectedContract = useStore((s) => s.setSelectedContract);

  return (
    <div className="h-full flex gap-2 p-3 min-h-0">

      {/* ── Left 60%: Health Grid ── */}
      <div className="w-[60%] flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2 flex-shrink-0">
          <span className="text-cyan-400 text-lg">🛡</span>
          <h2 className="text-sm font-bold text-gray-100 uppercase tracking-widest font-mono">
            Contract Health
          </h2>
          <span className="ml-auto text-xs text-gray-500 font-mono">
            {contracts.length} monitored contract{contracts.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {contracts.length === 0 ? (
            <div className="text-gray-600 text-xs font-mono p-3">
              No contract health data yet — waiting for mock events (Phase 9.5 at t=65s)...
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <AnimatePresence>
                {contracts.map((health) => (
                  <ContractHealthCard
                    key={health.contractAddress}
                    health={health}
                    isSelected={selectedContract === health.contractAddress}
                    onSelect={setSelectedContract}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* ── Right 40%: Vault Detail ── */}
      <div className="flex-1 min-h-0 border border-gray-900 rounded bg-gray-900/80 overflow-hidden">
        {selectedContract ? (
          <VaultDetail addr={selectedContract} />
        ) : (
          <EmptyVaultDetail />
        )}
      </div>
    </div>
  );
}
