import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNowStrict } from 'date-fns';
import useStore from '../store';
import { shortenAddress } from '../services/event-listener';
import { hashscan } from '../utils/hashscan';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { auctionTypeColor, auctionTypeLabel } from '../utils/auction-type';

// ── Risk bar ───────────────────────────────────────────────

function RiskBar({ score }) {
  const pct = Math.min(100, Math.max(0, score));
  let color;
  if (pct < 40) color = 'var(--accent-green)';
  else if (pct < 70) color = 'var(--accent-amber)';
  else color = 'var(--accent-red)';

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 font-sans w-7">Risk</span>
      <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full risk-bar-fill"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-mono w-10 text-right" style={{ color }}>
        {score}/100
      </span>
    </div>
  );
}

// ── TVL formatter ──────────────────────────────────────────

function formatTVL(amount) {
  if (!amount && amount !== 0) return '--';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount}`;
}

// ── Relative time that auto-updates ────────────────────────

function RelativeTime({ timestamp }) {
  const [display, setDisplay] = useState('');

  const update = useCallback(() => {
    if (!timestamp) { setDisplay('--'); return; }
    try {
      const d = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);
      setDisplay(formatDistanceToNowStrict(d, { addSuffix: true }));
    } catch {
      setDisplay('--');
    }
  }, [timestamp]);

  useEffect(() => {
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [update]);

  return <span className="text-[10px] text-gray-500 font-mono">{display}</span>;
}

// ── Discovery Card ─────────────────────────────────────────

function DiscoveryCard({ discovery }) {
  const {
    contractAddress,
    chain,
    estimatedLineCount,
    estimatedLOC,
    initialRiskScore,
    riskScore,
    contractType,
    tvlEstimate,
    discoveryTimestamp,
    timestamp,
  } = discovery;
  const classifier = discovery?.classifier && typeof discovery.classifier === 'object'
    ? discovery.classifier
    : {};
  const normalizedRiskScore = Number(initialRiskScore ?? riskScore ?? 0);
  const normalizedLineCount = Number(estimatedLineCount ?? estimatedLOC ?? 0);
  const riskSource = classifier.riskSource ?? discovery.riskSource ?? null;
  const riskModel = classifier.riskModel ?? discovery.riskModel ?? null;
  const topRiskFactors = Array.isArray(classifier.topRiskFactors)
    ? classifier.topRiskFactors
    : Array.isArray(discovery.topRiskFactors)
      ? discovery.topRiskFactors
      : [];

  const accentColor = auctionTypeColor(contractType);
  const typeLabel = auctionTypeLabel(contractType);
  const ts = discoveryTimestamp || timestamp;

  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (contractAddress) {
      navigator.clipboard.writeText(contractAddress).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className="card p-3 mb-2 relative overflow-hidden"
      style={{ borderLeftWidth: '2px', borderLeftColor: accentColor }}
    >
      {/* Glow flash on mount */}
      <motion.div
        initial={{ opacity: 0.3 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 1.5 }}
        className="absolute inset-0 pointer-events-none"
        style={{ background: `linear-gradient(90deg, ${accentColor}15 0%, transparent 60%)` }}
      />

      {/* Row 1: Type badge + timestamp */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse-glow"
            style={{ backgroundColor: accentColor }}
          />
          <span
            className="text-[10px] font-semibold tracking-wider font-sans uppercase"
            style={{ color: accentColor }}
          >
            {typeLabel}
          </span>
        </div>
        <RelativeTime timestamp={ts} />
      </div>

      {/* Row 2: Contract address */}
      <button
        onClick={handleCopy}
        className="font-mono text-xs text-gray-300 hover:text-white transition-colors mb-2 block text-left"
        title="Click to copy"
      >
        {copied ? 'Copied!' : shortenAddress(contractAddress)}
      </button>

      {/* Row 3: Chain + Lines */}
      <div className="flex items-center gap-4 mb-2 text-[11px]">
        <span className="text-gray-500 font-sans">
          Chain: <span className="text-gray-300 font-mono">{chain || '--'}</span>
        </span>
        <span className="text-gray-500 font-sans">
          Lines: <span className="text-gray-300 font-mono">{normalizedLineCount?.toLocaleString() || '--'}</span>
        </span>
      </div>

      {/* Row 4: Risk bar */}
      <div className="mb-2">
        <RiskBar score={normalizedRiskScore || 0} />
      </div>

      {/* Row 4.5: Classifier summary */}
      <div className="mb-2 text-[10px] text-gray-500 flex items-center justify-between gap-2">
        <span className="truncate">
          Source: <span className="text-gray-300 font-mono">{riskSource || '--'}</span>
        </span>
        <span className="truncate text-right">
          {riskModel || topRiskFactors[0]
            ? <span className="text-gray-300 font-mono">{riskModel || topRiskFactors[0]}</span>
            : '--'}
        </span>
      </div>

      {/* Row 5: TVL + HCS link */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-500 font-sans">
          TVL: <span className="text-gray-300 font-mono">{formatTVL(tvlEstimate)}</span>
        </span>
        {discovery._hcsSequence != null && discovery._hcsTopic && (
          <a
            href={hashscan.topicMessage(discovery._hcsTopic, discovery._hcsSequence)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-mono text-gray-700 hover:text-guard-cyan transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            seq #{discovery._hcsSequence}↗
          </a>
        )}
      </div>
    </motion.div>
  );
}

// ── Scanning empty state ───────────────────────────────────

function ScanningEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      {/* Radar animation */}
      <div className="relative w-20 h-20">
        {/* Rings */}
        {[0, 0.6, 1.2].map((delay) => (
          <div
            key={delay}
            className="absolute inset-0 border border-guard-amber/20 rounded-full animate-radar-ring"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
        {/* Center dot */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-guard-amber animate-pulse-glow" />
        </div>
        {/* Sweep line */}
        <div className="absolute inset-0 flex items-center justify-center animate-scan-sweep origin-center">
          <div className="w-10 h-px bg-gradient-to-r from-guard-amber/60 to-transparent" />
        </div>
      </div>
      <p className="text-xs text-gray-500 font-sans tracking-wider uppercase">
        Scanning for contract deployments...
      </p>
    </div>
  );
}

// ── Main Feed ──────────────────────────────────────────────

export default function DiscoveryFeed() {
  const discoveries = useStore((s) => s.discoveries);
  const config = useStore((s) => s.config);
  const topicId = config?.hcsTopics?.discovery || '...';

  const visible = discoveries.slice(0, 20);
  const { containerRef } = useAutoScroll(discoveries.length);

  return (
    <div className="panel flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          {/* Radar icon */}
          <div className="relative w-4 h-4 flex items-center justify-center">
            <div className="absolute w-3 h-3 border border-guard-amber/30 rounded-full animate-radar-ring" />
            <div className="w-1 h-1 rounded-full bg-guard-amber" />
          </div>
          <h2 className="text-xs font-semibold tracking-wider uppercase font-sans text-guard-amber">
            Contract Discoveries
          </h2>
          <span className="text-[10px] text-gray-600 font-mono ml-1">
            ({discoveries.length})
          </span>
        </div>
        <span className="text-[9px] text-gray-600 font-mono hidden lg:block">
          via HCS {topicId}
        </span>
      </div>

      {/* Content */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-3 min-h-0">
        {visible.length === 0 ? (
          <ScanningEmptyState />
        ) : (
          <AnimatePresence initial={false}>
            {visible.map((d, i) => (
              <DiscoveryCard
                key={d.contractAddress + '-' + (d.discoveryTimestamp || d.timestamp || i)}
                discovery={d}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
