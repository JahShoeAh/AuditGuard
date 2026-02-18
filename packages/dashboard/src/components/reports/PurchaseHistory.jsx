import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import { fmt } from '../../utils/format';
import { CATEGORY_META, starsFromRating } from './reportConstants';

// ── Mini star display ──────────────────────────────────────

function MiniStars({ rating }) {
  if (!rating) return <span className="text-gray-700 text-[11px]">Not rated</span>;
  return (
    <span className="text-amber-400 text-[11px]">
      {'★'.repeat(rating)}{'☆'.repeat(5 - rating)}
    </span>
  );
}

// ── Purchase row ───────────────────────────────────────────

function PurchaseRow({ purchase, listing, onView }) {
  const catId   = Number(listing?.category ?? 0);
  const catMeta = CATEGORY_META[catId] ?? CATEGORY_META[7];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-3 py-2.5 px-3 border border-gray-800 rounded-lg bg-gray-900 hover:border-gray-700 transition-colors"
    >
      <span className="text-lg flex-shrink-0">{catMeta.icon}</span>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold font-mono text-gray-200 truncate">
          {listing?.title || purchase.title || 'Unknown Report'}
        </p>
        <p className="text-[11px] font-mono text-gray-500">
          {purchase.sellerName || listing?.sellerName || '—'}
          {' · '}
          {purchase.pricePaidFormatted || '—'}
          {' · '}
          {fmt.relativeTime(purchase.timestamp)}
        </p>
      </div>

      <MiniStars rating={purchase.rating} />

      <button
        type="button"
        onClick={() => onView(listing || { listingId: purchase.listingId })}
        className="flex-shrink-0 text-[11px] font-bold font-mono uppercase px-2 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors whitespace-nowrap"
      >
        View →
      </button>
    </motion.div>
  );
}

// ── PurchaseHistory ────────────────────────────────────────

/**
 * Props:
 *   sessionPurchasedIds  Set<listingId>   — purchased this session
 *   onView               (listing) => void
 */
export default function PurchaseHistory({ sessionPurchasedIds, onView }) {
  const myAddress   = useWalletStore((s) => s.address);
  const purchases   = useStore((s) => s.dataPurchases);
  const dataListings = useStore((s) => s.dataListings);

  if (!myAddress) return null;

  // Filter to purchases made by the connected wallet
  const myPurchases = purchases.filter(
    (p) => p.buyer?.toLowerCase() === myAddress.toLowerCase()
  );

  // Also fold in session purchases that might not yet be in dataPurchases
  const shownIds = new Set(myPurchases.map((p) => p.listingId?.toString()));
  sessionPurchasedIds.forEach((id) => {
    if (!shownIds.has(id?.toString())) {
      myPurchases.push({
        listingId: id,
        buyer: myAddress,
        timestamp: Date.now(),
        title: dataListings[id]?.title || 'Report',
        sellerName: dataListings[id]?.sellerName || '—',
        pricePaidFormatted: '—',
        rating: null,
      });
    }
  });

  if (myPurchases.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-xs font-bold font-mono uppercase tracking-widest text-gray-400">
          Your Purchase History
        </h2>
        <span className="text-[10px] font-mono text-gray-600">
          ({myPurchases.length} report{myPurchases.length !== 1 ? 's' : ''})
        </span>
      </div>

      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {myPurchases.map((purchase) => {
            const listing = dataListings[purchase.listingId];
            return (
              <PurchaseRow
                key={purchase.listingId}
                purchase={purchase}
                listing={listing}
                onView={onView}
              />
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
}
