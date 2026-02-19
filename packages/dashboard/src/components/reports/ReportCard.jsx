import { motion } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import { fmt } from '../../utils/format';
import {
  CATEGORY_META,
  LISTING_TYPE_META,
  CAT_COLOR_CLASSES,
  fmtGuard,
  starsFromRating,
  HUMAN_CATEGORY_IDS,
} from './reportConstants';

// ── Star rating display ────────────────────────────────────

function StarDisplay({ avg, count }) {
  if (!avg && avg !== 0) {
    return <span className="text-gray-600 text-[11px] font-mono">No ratings yet</span>;
  }
  const { full, half, empty } = starsFromRating(avg);
  return (
    <span className="flex items-center gap-1">
      <span className="text-amber-400 text-xs tracking-tight" aria-label={`${avg} stars`}>
        {'★'.repeat(full)}
        {half ? '½' : ''}
        {'☆'.repeat(empty)}
      </span>
      <span className="text-gray-400 text-[11px] font-mono">
        {avg.toFixed(1)} ({count})
      </span>
    </span>
  );
}

// ── Tier badge ─────────────────────────────────────────────

const TIER_BADGE = {
  0: 'bg-gray-700 text-gray-300',
  1: 'bg-cyan-900/60 text-cyan-300',
  2: 'bg-amber-900/60 text-amber-300',
};
const TIER_LABELS = ['COMMODITY', 'SPECIALIZED', 'PREMIUM'];

// ── Category badge ─────────────────────────────────────────

function CategoryBadge({ category }) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META[7];
  const cc   = CAT_COLOR_CLASSES[meta.color] ?? CAT_COLOR_CLASSES.gray;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${cc.border} ${cc.bg} ${cc.text}`}>
      {meta.icon} {meta.label}
    </span>
  );
}

function TypeBadge({ listingType }) {
  const meta = LISTING_TYPE_META[listingType] ?? LISTING_TYPE_META[0];
  const cc   = CAT_COLOR_CLASSES[meta.color] ?? CAT_COLOR_CLASSES.gray;
  return (
    <span className={`inline-flex items-center text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${cc.border} ${cc.bg} ${cc.text}`}>
      {meta.label}
    </span>
  );
}

// ── BuyerBar ───────────────────────────────────────────────

function BuyerBar({ buyerCount, maxBuyers }) {
  if (!maxBuyers) return <span className="text-gray-500">Unlimited</span>;
  const pct = Math.min(100, (buyerCount / maxBuyers) * 100);
  return (
    <span className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-gray-700 rounded overflow-hidden">
        <div
          className={`h-full rounded ${pct >= 100 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-400' : 'bg-guard-amber'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-gray-400 text-[11px]">{buyerCount}/{maxBuyers}</span>
    </span>
  );
}

// ── ReportCard ─────────────────────────────────────────────

/**
 * Props:
 *   listing     DataListing object from store
 *   hasAccess   bool — user has already purchased
 *   rating      { avg: number, count: number } | null
 *   onPurchase  () => void — opens the purchase modal
 *   onView      () => void — opens the viewer
 */
export default function ReportCard({ listing, hasAccess, rating, onPurchase, onView }) {
  const agents     = useStore((s) => s.agents);
  const activeJobs = useStore((s) => s.activeJobs);
  const connected  = useWalletStore((s) => s.connectionStatus === 'connected');
  const openWallet = useWalletStore((s) => s.openWalletModal);

  const seller    = agents[listing.seller?.toLowerCase()] || {};
  const repNum    = seller.reputationScore
    ? (Number(seller.reputationScore) / 100).toFixed(2)
    : (listing.sellerReputation ? (Number(listing.sellerReputation) / 100).toFixed(2) : '—');
  const tierNum   = seller.tier ?? listing.sellerTier ?? 0;
  const tierLabel = TIER_LABELS[tierNum] ?? 'COMMODITY';
  const tierBadge = TIER_BADGE[tierNum] ?? TIER_BADGE[0];

  const job      = listing.parentJobId ? activeJobs[listing.parentJobId] : null;
  const catId    = Number(listing.category ?? 0);
  const typeId   = Number(listing.listingType ?? 0);

  const buyerCount = Number(listing.buyerCount ?? 0);
  const maxBuyers  = Number(listing.maxBuyers ?? 0);
  const isSoldOut  = maxBuyers > 0 && buyerCount >= maxBuyers;
  const isExpired  = listing.expiresAt && Date.now() > Number(listing.expiresAt) * 1000;
  const isActive   = listing.active && !isSoldOut && !isExpired;
  const priceRaw   = listing.price ?? 0n;

  const handlePurchaseClick = () => {
    if (!connected) { openWallet({ action: 'purchase audit reports' }); return; }
    onPurchase();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={[
        'rounded-xl border bg-gray-900/80 p-4 flex flex-col gap-3 transition-all',
        hasAccess
          ? 'border-green-500/30'
          : isActive
          ? 'border-gray-900 hover:border-gray-700'
          : 'border-gray-900 opacity-60',
      ].join(' ')}
    >
      {/* ── Title + badge row ── */}
      <div className="flex items-start gap-2">
        <span className="text-xl flex-shrink-0 mt-0.5">
          {CATEGORY_META[catId]?.icon ?? '📄'}
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold font-mono text-gray-100 leading-snug line-clamp-2">
            {listing.title || 'Untitled Report'}
          </h3>
          {listing.description && (
            <p className="text-[11px] font-mono text-gray-500 mt-1 line-clamp-2 leading-relaxed">
              {listing.description}
            </p>
          )}
        </div>
      </div>

      {/* ── Seller row ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-mono text-gray-500">By:</span>
        <span className="text-[11px] font-bold font-mono text-gray-200">
          {listing.sellerName || fmt.address(listing.seller)}
        </span>
        {repNum !== '—' && (
          <span className="text-[11px] font-mono text-guard-amber">★{repNum}</span>
        )}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${tierBadge}`}>
          {tierLabel}
        </span>
      </div>

      {/* ── Rating ── */}
      <StarDisplay avg={rating?.avg} count={rating?.count} />

      {/* ── Category + type badges ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <CategoryBadge category={catId} />
        <TypeBadge listingType={typeId} />
        {hasAccess && (
          <span className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border border-green-500/50 bg-green-500/10 text-green-300">
            ✓ Purchased
          </span>
        )}
      </div>

      {/* ── Job linkage ── */}
      {job && (
        <div className="text-[11px] font-mono text-gray-500 border-t border-gray-800 pt-2">
          <span className="text-gray-600">For: </span>
          <span className="text-guard-amber">{fmt.address(job.contractAddress || '')}</span>
          {job.contractType && (
            <span className="ml-1 text-gray-600 uppercase">({job.contractType.replace(/_/g,' ')})</span>
          )}
          <span className="ml-2 text-gray-600">· Job #{listing.parentJobId?.toString().slice(-4) ?? '?'}</span>
        </div>
      )}

      {/* ── Price + buyer count ── */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-base font-bold font-mono text-amber-300">
            {fmtGuard(priceRaw)} GUARD
          </span>
        </div>
        <BuyerBar buyerCount={buyerCount} maxBuyers={maxBuyers} />
      </div>

      {/* ── Listing age ── */}
      <div className="text-[10px] font-mono text-gray-600">
        Listed: {fmt.relativeTime(listing.listedAt || listing._tx?.timestamp || Date.now())}
        {listing.expiresAt && (
          <span className="ml-2">
            · Expires: {fmt.relativeTime(Number(listing.expiresAt) * 1000)}
          </span>
        )}
      </div>

      {/* ── Action button ── */}
      {hasAccess ? (
        <button
          type="button"
          onClick={onView}
          className="w-full py-2 text-xs font-bold font-mono uppercase tracking-wider rounded border border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500/20 transition-colors"
        >
          ✓ View Report
        </button>
      ) : isSoldOut ? (
        <button disabled className="w-full py-2 text-xs font-mono text-gray-600 rounded border border-gray-800 bg-gray-900 cursor-not-allowed">
          Sold Out
        </button>
      ) : isExpired ? (
        <button disabled className="w-full py-2 text-xs font-mono text-gray-600 rounded border border-gray-800 bg-gray-900 cursor-not-allowed">
          Expired
        </button>
      ) : connected ? (
        <button
          type="button"
          onClick={handlePurchaseClick}
          className="w-full py-2 text-xs font-bold font-mono uppercase tracking-wider rounded border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          Purchase Report
        </button>
      ) : (
        <button
          type="button"
          onClick={handlePurchaseClick}
          className="w-full py-2 text-xs font-bold font-mono uppercase tracking-wider rounded border border-gray-600 bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
        >
          Connect Wallet to Purchase
        </button>
      )}
    </motion.div>
  );
}
