import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { hashscan } from '../utils/hashscan';

const EVENTS_API_BASE_URL = (
  import.meta.env.VITE_EVENTS_API_BASE_URL || '/api'
).replace(/\/$/, '');

function short(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ActiveBadge({ active }) {
  if (!active) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded border"
        style={{ color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)' }}
      >
        ✕ INACTIVE
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded border"
      style={{ color: 'var(--accent-green)', borderColor: 'rgba(52,211,153,0.3)', background: 'rgba(52,211,153,0.08)' }}
    >
      ● ACTIVE
    </span>
  );
}

function VaultRow({ vault }) {
  const { contractAddress, vaultAddress, creator, contractChain, active, createdAt } = vault;
  const created = createdAt ? new Date(createdAt).toLocaleString() : '—';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="border border-gray-800 rounded-lg p-3 flex flex-col gap-2 hover:border-gray-700 transition-colors"
      style={{ background: 'rgba(17,24,39,0.6)' }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={hashscan.account ? hashscan.account(contractAddress) : `https://hashscan.io/testnet/account/${contractAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          {short(contractAddress)}
        </a>
        <ActiveBadge active={active} />
        <span className="text-[10px] font-mono text-gray-600">{contractChain}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[10px] font-mono">
        <div>
          <span className="text-gray-600 uppercase tracking-wider">Vault</span>
          <div>
            <a
              href={hashscan.account ? hashscan.account(vaultAddress) : `https://hashscan.io/testnet/account/${vaultAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 transition-colors"
            >
              {short(vaultAddress)}
            </a>
          </div>
        </div>
        <div>
          <span className="text-gray-600 uppercase tracking-wider">Creator</span>
          <div className="text-gray-300">{short(creator) || '—'}</div>
        </div>
        <div>
          <span className="text-gray-600 uppercase tracking-wider">Created</span>
          <div className="text-gray-400">{created}</div>
        </div>
      </div>
    </motion.div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 py-12">
      <span className="text-4xl opacity-30">🏦</span>
      <p className="text-xs font-mono text-gray-500 text-center max-w-xs">
        No vaults registered yet. Call{' '}
        <span className="text-cyan-500">VaultFactory.createVault()</span>{' '}
        to register a contract vault.
      </p>
    </div>
  );
}

export default function VaultPanel() {
  const [vaults, setVaults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchVaults() {
      try {
        const res = await fetch(`${EVENTS_API_BASE_URL}/vaults?limit=100`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setVaults(body.data?.vaults ?? []);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchVaults();
    const interval = setInterval(fetchVaults, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const activeCount = vaults.filter((v) => v.active).length;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center gap-3">
        <span className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-500">
          VAULT REGISTRY
        </span>
        {activeCount > 0 && (
          <span
            className="text-[10px] font-mono px-2 py-0.5 rounded-full font-bold"
            style={{ background: 'rgba(34,211,238,0.12)', color: 'var(--accent-cyan)' }}
          >
            {activeCount} active
          </span>
        )}
        {loading && (
          <span className="text-[10px] font-mono text-gray-600 animate-pulse">loading…</span>
        )}
        {error && (
          <span className="text-[10px] font-mono text-red-500">{error}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!loading && vaults.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {vaults.map((v) => (
                <VaultRow key={v.contractAddress} vault={v} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
