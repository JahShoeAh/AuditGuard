import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import useStore from '../store';
import { hashscan } from '../utils/hashscan';
import WalletButton from './wallet/WalletButton';
import WalletGate from './wallet/WalletGate';

// ── Stat chip with pulse on value change ───────────────────

function StatChip({ label, value, accentColor, format }) {
  const prevRef = useRef(value);
  const chipRef = useRef(null);

  useEffect(() => {
    if (value !== prevRef.current && chipRef.current) {
      chipRef.current.classList.remove('animate-stat-bump');
      // Force reflow to restart animation
      void chipRef.current.offsetWidth;
      chipRef.current.classList.add('animate-stat-bump');
      prevRef.current = value;
    }
  }, [value]);

  const display = format ? format(value) : value;

  return (
    <div
      ref={chipRef}
      className="flex flex-col items-center px-3 py-1.5 rounded bg-guard-dark/60 min-w-[80px]"
    >
      <span
        className="font-mono text-sm font-semibold"
        style={{ color: accentColor, fontVariantNumeric: 'tabular-nums' }}
      >
        {display}
      </span>
      <span className="text-[9px] uppercase tracking-wider text-gray-500 font-sans mt-0.5">
        {label}
      </span>
    </div>
  );
}

// ── Network status badge ───────────────────────────────────

function NetworkStatus({ isConnected, connectionError, guardTokenId }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <span className={isConnected ? 'status-dot-connected' : 'status-dot-disconnected'} />
        <span className="text-xs font-semibold tracking-wider font-sans" style={{
          color: isConnected ? 'var(--accent-green)' : 'var(--accent-red)',
        }}>
            {isConnected ? (
          <a
            href={hashscan.networkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            HEDERA TESTNET↗
          </a>
        ) : connectionError ? 'DISCONNECTED' : 'CONNECTING'}
        </span>
      </div>
      {guardTokenId && (
        <span className="text-[10px] font-mono text-gray-600">
          GUARD {guardTokenId}
        </span>
      )}
    </div>
  );
}

// ── Mock events toggle ─────────────────────────────────────

function MockToggle() {
  const useMockEvents = useStore((s) => s.useMockEvents);
  const toggleMock = useStore((s) => s.toggleMockEvents);

  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none">
      <span className="text-[10px] text-gray-500 font-sans uppercase tracking-wider">
        {useMockEvents ? 'Mock' : 'Live'}
      </span>
      <div className="relative">
        <input
          type="checkbox"
          checked={useMockEvents}
          onChange={toggleMock}
          className="sr-only peer"
        />
        <div className="w-7 h-3.5 bg-gray-700 rounded-full peer-checked:bg-guard-amber/30 transition-colors" />
        <div className="absolute top-0.5 left-0.5 w-2.5 h-2.5 bg-gray-400 rounded-full peer-checked:translate-x-3.5 peer-checked:bg-guard-amber transition-all" />
      </div>
    </label>
  );
}

// ── Main Header ────────────────────────────────────────────

export default function Header() {
  const isConnected = useStore((s) => s.isConnected);
  const connectionError = useStore((s) => s.connectionError);
  const config = useStore((s) => s.config);
  const stats = useStore((s) => s.stats);

  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="panel px-5 py-3 flex items-center justify-between gap-4"
    >
      {/* Left — Wordmark */}
      <Link to="/" className="flex-shrink-0 group">
        <h1 className="text-lg font-bold tracking-tight font-mono leading-tight group-hover:opacity-80 transition-opacity">
          <span className="text-guard-amber glow-text-subtle">AUDIT</span>
          <span className="text-gray-200">GUARD</span>
        </h1>
        <p className="text-[10px] text-gray-500 tracking-[0.2em] uppercase font-sans">
          Autonomous Security Marketplace
        </p>
      </Link>

      {/* Center — Network status */}
      <div className="flex items-center gap-4">
        <NetworkStatus
          isConnected={isConnected}
          connectionError={connectionError}
          guardTokenId={config?.guardTokenId}
        />
        <MockToggle />
      </div>

      {/* Right — Live stats */}
      <div className="flex items-center gap-2">
        <WalletGate>
          <Link
            to="/dashboard/reports"
            className="rounded border border-gray-600 bg-gray-800/60 px-3 py-1.5 text-[10px] font-bold font-mono uppercase tracking-wider text-gray-300 hover:bg-gray-700 hover:border-gray-500"
          >
            Reports
          </Link>
        </WalletGate>
        <WalletGate>
          <Link
            to="/dashboard/agents/register"
            className="rounded border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-[10px] font-bold font-mono uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/20"
          >
            Deploy Agent
          </Link>
        </WalletGate>
        <WalletButton />
        <StatChip
          label="Discoveries"
          value={stats.totalDiscoveries}
          accentColor="var(--accent-cyan)"
        />
        <StatChip
          label="Auctions"
          value={stats.totalAuctions}
          accentColor="var(--accent-amber)"
        />
        <StatChip
          label="Sub-contracts"
          value={stats.totalSubAuctions}
          accentColor="var(--accent-purple)"
        />
        <StatChip
          label="Data Sales"
          value={stats.totalDataSales}
          accentColor="#14b8a6"
        />
        <StatChip
          label="GUARD Settled"
          value={stats.totalGuardTransacted}
          accentColor="var(--accent-gold)"
          format={(v) => (v > 0 ? `${v.toFixed(2)}` : '0')}
        />
      </div>
    </motion.header>
  );
}
