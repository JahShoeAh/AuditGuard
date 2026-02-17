import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import useStore from '../store';

// ── Category configuration ────────────────────────────────

const CATEGORY_CONFIG = {
  SCAN_REPORT:         { icon: '📄', color: '#22c55e', label: 'Scan Report' },
  DEPENDENCY_ANALYSIS: { icon: '🌳', color: '#9c27b0', label: 'Dep Analysis' },
  EXPLOIT_DATABASE:    { icon: '🛡', color: '#ef4444', label: 'Exploit DB' },
  HOT_LEAD:            { icon: '📡', color: '#06b6d4', label: 'Hot Lead' },
  FUZZING_SEEDS:       { icon: '🐛', color: '#f59e0b', label: 'Fuzz Seeds' },
  THREAT_INTEL:        { icon: '⚠', color: '#ef4444', label: 'Threat Intel' },
};

const DATA_CATEGORIES = [
  'SCAN_REPORT',
  'DEPENDENCY_ANALYSIS',
  'EXPLOIT_DATABASE',
  'HOT_LEAD',
  'FUZZING_SEEDS',
  'THREAT_INTEL',
];

// ── Star rating display ───────────────────────────────────

function StarRating({ rating, count }) {
  const rounded = Math.round(rating || 0);
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-[10px]">
        <span style={{ color: 'var(--accent-amber)' }}>{'★'.repeat(rounded)}</span>
        <span className="text-gray-600">{'☆'.repeat(5 - rounded)}</span>
      </span>
      {count != null && (
        <span className="text-[9px] text-gray-600 font-mono">({count})</span>
      )}
    </span>
  );
}

// ── Main DataListingCard ──────────────────────────────────

export default function DataListingCard({ listingId }) {
  const listing = useStore((s) => s.dataListings[listingId]);
  const allPurchases = useStore((s) => s.dataPurchases);

  const purchases = useMemo(
    () => allPurchases.filter((p) => p.listingId === listingId),
    [allPurchases, listingId]
  );

  const { avgRating, ratingCount } = useMemo(() => {
    const rated = purchases.filter((p) => p.rating);
    if (rated.length === 0) return { avgRating: null, ratingCount: 0 };
    return {
      avgRating: rated.reduce((sum, p) => sum + p.rating, 0) / rated.length,
      ratingCount: rated.length,
    };
  }, [purchases]);

  if (!listing) return null;

  const catStr = DATA_CATEGORIES[listing.category] || listing.categoryStr || 'SCAN_REPORT';
  const catConf = CATEGORY_CONFIG[catStr] || CATEGORY_CONFIG.SCAN_REPORT;
  const borderColor = purchases.length > 0 ? 'var(--accent-green)' : '#14b8a6';

  return (
    <div
      className="rounded-md p-2.5 text-[11px]"
      style={{ borderLeft: `2px solid ${borderColor}`, background: 'rgba(255,255,255,0.02)' }}
    >
      {/* Header: listing id + category + type + price */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className="text-gray-500 font-mono text-[9px]">DATA #{listingId}</span>
            <span
              className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
              style={{ backgroundColor: `${catConf.color}20`, color: catConf.color }}
            >
              {catConf.icon} {catConf.label}
            </span>
            <span
              className="text-[9px] px-1 py-0.5 rounded text-gray-500"
              style={{ background: 'rgba(255,255,255,0.05)' }}
            >
              {listing.listingTypeStr || 'ONE_TIME'}
            </span>
          </div>
          <p
            className="text-gray-300 font-mono leading-tight truncate"
            title={listing.title}
          >
            {listing.title || 'Untitled listing'}
          </p>
        </div>
        <span className="font-mono font-semibold flex-shrink-0" style={{ color: 'var(--accent-gold)' }}>
          {listing.priceFormatted}
        </span>
      </div>

      {/* Seller + buyer count + rating */}
      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-1.5 flex-wrap">
        <span>
          Seller: <span className="text-gray-400">{listing.sellerName || listing.seller}</span>
        </span>
        <span>
          Buyers: <span className="text-gray-400">{purchases.length}</span>
        </span>
        {avgRating != null && (
          <StarRating rating={avgRating} count={ratingCount} />
        )}
      </div>

      {/* Purchase list — animates in new entries */}
      <AnimatePresence initial={false}>
        {purchases.map((p, i) => (
          <motion.div
            key={`${p.buyer}-${p.timestamp || i}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25 }}
            className="flex items-center gap-2 text-[10px] text-gray-500 mb-0.5"
          >
            <span className="text-gray-600">→</span>
            <span className="text-gray-400">{p.buyerName || p.buyer}</span>
            <span>bought for</span>
            <span className="font-mono" style={{ color: 'var(--accent-gold)' }}>
              {p.pricePaidFormatted}
            </span>
            {p.timestamp && (
              <span className="text-[9px] text-gray-600 ml-auto">
                {formatDistanceToNow(new Date(p.timestamp), { addSuffix: true })}
              </span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
