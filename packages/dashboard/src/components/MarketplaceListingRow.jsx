import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import useStore from '../store';
import { hashscan } from '../utils/hashscan';
import WalletGate from './wallet/WalletGate';

// ── Category + listing type config ───────────────────────────

const CATEGORY_CONFIG = {
  SCAN_REPORT:         { icon: '📄', color: '#22c55e', label: 'SCAN' },
  DEPENDENCY_ANALYSIS: { icon: '🌳', color: '#9c27b0', label: 'DEP' },
  EXPLOIT_DATABASE:    { icon: '🛡', color: '#ef4444', label: 'EXPLOIT' },
  HOT_LEAD:            { icon: '📡', color: '#06b6d4', label: 'HOT LEAD' },
  FUZZING_SEEDS:       { icon: '🐛', color: '#f59e0b', label: 'FUZZ' },
  THREAT_INTEL:        { icon: '⚠', color: '#ef4444', label: 'INTEL' },
};

const DATA_CATEGORIES = [
  'SCAN_REPORT', 'DEPENDENCY_ANALYSIS', 'EXPLOIT_DATABASE',
  'HOT_LEAD', 'FUZZING_SEEDS', 'THREAT_INTEL',
];

const LISTING_TYPE_STYLES = {
  ONE_TIME:     { label: 'ONE-TIME', color: '#22c55e',  pulse: false },
  SUBSCRIPTION: { label: 'SUB',      color: '#a855f7',  pulse: true  },
  TIP:          { label: 'TIP',      color: '#f59e0b',  pulse: false },
};

// ── Main component ────────────────────────────────────────────

export default function MarketplaceListingRow({ listing, isNew }) {
  const allPurchases = useStore((s) => s.dataPurchases);
  const [flash, setFlash] = useState(false);
  const prevCountRef = useRef(null);

  const purchases  = allPurchases.filter((p) => p.listingId === listing.listingId);
  const buyerCount = purchases.length;

  // Flash gold when buyer count increases
  useEffect(() => {
    if (prevCountRef.current !== null && buyerCount > prevCountRef.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(t);
    }
    prevCountRef.current = buyerCount;
  }, [buyerCount]);

  const catStr   = DATA_CATEGORIES[listing.category] ?? listing.categoryStr ?? 'SCAN_REPORT';
  const catConf  = CATEGORY_CONFIG[catStr]              ?? CATEGORY_CONFIG.SCAN_REPORT;
  const typeConf = LISTING_TYPE_STYLES[listing.listingTypeStr] ?? LISTING_TYPE_STYLES.ONE_TIME;

  const ratedPurchases = purchases.filter((p) => p.rating);
  const avgRating = ratedPurchases.length > 0
    ? ratedPurchases.reduce((s, p) => s + p.rating, 0) / ratedPurchases.length
    : null;

  const hasParentJob = listing.parentJobId && listing.parentJobId !== '0';

  return (
    <motion.div
      layout
      initial={isNew ? { opacity: 0, y: -12 } : false}
      animate={{
        opacity: 1,
        y: 0,
        boxShadow: flash
          ? '0 0 12px rgba(212,160,23,0.35)'
          : '0 0 0px rgba(0,0,0,0)',
      }}
      transition={{ duration: 0.25 }}
      className="px-3 py-2.5 border-b border-white/[0.03] hover:bg-white/[0.015] transition-colors cursor-default"
    >
      {/* Row 1 — icon + title + price */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-base flex-shrink-0 leading-none">{catConf.icon}</span>
          <span
            className="text-[11px] font-mono text-gray-300 truncate"
            title={listing.title}
          >
            {listing.title || 'Untitled'}
          </span>
        </div>
        <span
          className="text-[11px] font-mono font-bold flex-shrink-0"
          style={{ color: 'var(--accent-gold)', fontVariantNumeric: 'tabular-nums' }}
        >
          {listing.priceFormatted}
        </span>
      </div>

      {/* Row 2 — seller + category badge + listing type */}
      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
        <span className="text-[10px] text-gray-500 font-mono">
          {listing.sellerName || listing.seller}
        </span>
        <span className="text-gray-700">•</span>
        <span
          className="text-[9px] px-1.5 py-px rounded font-semibold"
          style={{ backgroundColor: `${catConf.color}1a`, color: catConf.color }}
        >
          {catConf.label}
        </span>
        <motion.span
          animate={typeConf.pulse ? { opacity: [1, 0.45, 1] } : {}}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-[9px] px-1.5 py-px rounded font-semibold"
          style={{ backgroundColor: `${typeConf.color}1a`, color: typeConf.color }}
        >
          {typeConf.label}
        </motion.span>
      </div>

      {/* Row 3 — buyer count + rating + job link */}
      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-600 flex-wrap">
        <motion.span
          key={buyerCount}
          initial={{ scale: 1.25, color: '#d97706' }}
          animate={{ scale: 1, color: '#6b7280' }}
          transition={{ duration: 0.3 }}
        >
          {buyerCount} buyer{buyerCount !== 1 ? 's' : ''}
        </motion.span>

        {avgRating !== null && (
          <>
            <span className="text-gray-700">•</span>
            <span>
              <span style={{ color: 'var(--accent-amber)' }}>
                {'★'.repeat(Math.round(avgRating))}
              </span>
              <span className="text-gray-700">
                {'☆'.repeat(5 - Math.round(avgRating))}
              </span>
              <span className="text-gray-600 ml-1 text-[9px]">
                ({ratedPurchases.length})
              </span>
            </span>
          </>
        )}

        <span className="text-gray-700">•</span>
        <span style={{ color: hasParentJob ? 'var(--accent-cyan)' : undefined }}>
          {hasParentJob ? `Job #${listing.parentJobId}` : 'Standalone'}
        </span>

        {listing._tx?.hash && (
          <a
            href={hashscan.transaction(listing._tx.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-mono text-gray-700 hover:text-guard-cyan transition-colors ml-auto"
            onClick={(e) => e.stopPropagation()}
          >
            tx↗
          </a>
        )}
        {!listing._tx?.hash && listing.blockNumber && (
          <span className="text-[9px] text-gray-700 ml-auto">
            blk #{listing.blockNumber}
          </span>
        )}
      </div>

      <WalletGate>
        <div className="mt-2 flex justify-end">
          <Link
            to="/dashboard/reports"
            className="rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20"
          >
            Purchase
          </Link>
        </div>
      </WalletGate>
    </motion.div>
  );
}
