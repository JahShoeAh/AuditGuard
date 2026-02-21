import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Header from '../components/Header';
import WalletButton from '../components/wallet/WalletButton';
import useStore from '../store/index';
import useWalletStore from '../store/wallet';
import ReportCard from '../components/reports/ReportCard';
import PurchaseModal from '../components/reports/PurchaseModal';
import ReportViewer from '../components/reports/ReportViewer';
import PurchaseHistory from '../components/reports/PurchaseHistory';
import UserReportList from '../components/reports/UserReportList';
import { HUMAN_FILTER_TABS, HUMAN_CATEGORY_IDS, fmtGuard } from '../components/reports/reportConstants';
import { fmt } from '../utils/format';

// ── Filter pill ────────────────────────────────────────────
function FilterPill({ label, icon, active, count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono font-semibold transition-all whitespace-nowrap',
        active
          ? 'bg-guard-amber/15 border border-guard-amber/50 text-guard-amber'
          : 'bg-gray-900/60 border border-gray-900 text-gray-500 hover:border-gray-700 hover:text-gray-300',
      ].join(' ')}
    >
      {icon && <span>{icon}</span>}
      {label}
      {count != null && count > 0 && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${active ? 'bg-guard-amber/20 text-guard-amber' : 'bg-gray-800 text-gray-500'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── Derive ratings from store.dataPurchases ────────────────
function useRatings() {
  const purchases = useStore((s) => s.dataPurchases);
  return useMemo(() => {
    const map = {};
    for (const p of purchases) {
      if (!p.listingId || !p.rating) continue;
      const key = p.listingId.toString();
      if (!map[key]) map[key] = { sum: 0, count: 0 };
      map[key].sum   += Number(p.rating);
      map[key].count += 1;
    }
    const result = {};
    for (const [id, { sum, count }] of Object.entries(map)) {
      result[id] = { avg: sum / count, count };
    }
    return result;
  }, [purchases]);
}

// ── Empty state ────────────────────────────────────────────
function EmptyState({ contractSearch }) {
  if (contractSearch) {
    return (
      <div className="col-span-full text-center py-16">
        <div className="text-4xl mb-3">🔍</div>
        <p className="text-sm font-mono text-gray-500">No reports available for this contract yet.</p>
        <p className="text-xs font-mono text-gray-700 mt-2 max-w-sm mx-auto">
          If your contract has an audit vault with sufficient budget, agents will audit it automatically.
        </p>
        <Link
          to="/dashboard"
          className="inline-block mt-4 text-xs font-mono text-guard-amber hover:text-amber-300 hover:underline"
        >
          ← Set up an audit vault
        </Link>
      </div>
    );
  }
  return (
    <div className="col-span-full text-center py-16">
      <motion.div
        animate={{ opacity: [0.4, 0.8, 0.4] }}
        transition={{ duration: 3, repeat: Infinity }}
        className="text-4xl mb-3"
      >
        📄
      </motion.div>
      <p className="text-sm font-mono text-gray-500">No reports available yet.</p>
      <p className="text-xs font-mono text-gray-700 mt-2">
        Autonomous agents will list reports as audits complete.
      </p>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────

export default function ReportMarketplace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [contractSearch, setContractSearch] = useState(() => searchParams.get('contract') || '');
  const [catFilter,  setCatFilter]  = useState(null); // null = ALL, otherwise category id
  const [typeFilter, setTypeFilter] = useState(null); // null = ALL
  const [priceSort,  setPriceSort]  = useState(null); // null | 'asc' | 'desc'
  const [ratingMin,  setRatingMin]  = useState(null); // null | 3 | 4
  const [purchaseModal,  setPurchaseModal]  = useState(null); // listing | null
  const [viewerListing,  setViewerListing]  = useState(null); // listing | null
  const [sessionPurchasedIds, setSessionPurchasedIds] = useState(new Set());
  const [showMineOnly, setShowMineOnly] = useState(false);

  const dataListings  = useStore((s) => s.dataListings);
  const jobListings   = useStore((s) => s.jobListings);   // parentJobId → listingId[]
  const activeJobs    = useStore((s) => s.activeJobs);
  const reportMeta    = useStore((s) => s.reportMetadata);
  const dataPurchases = useStore((s) => s.dataPurchases);
  const myAddress     = useWalletStore((s) => s.address);
  const ratings       = useRatings();

  // Sync ?contract= URL param
  useEffect(() => {
    const addr = searchParams.get('contract');
    if (addr) setContractSearch(addr);
  }, [searchParams]);

  const updateContractSearch = (val) => {
    setContractSearch(val);
    if (val) setSearchParams({ contract: val }, { replace: true });
    else setSearchParams({}, { replace: true });
  };

  // ── Build set of listings accessible by this wallet ──────
  const accessSet = useMemo(() => {
    const s = new Set(sessionPurchasedIds);
    for (const p of dataPurchases) {
      if (p.buyer?.toLowerCase() === myAddress?.toLowerCase()) {
        s.add(p.listingId?.toString());
      }
    }
    return s;
  }, [dataPurchases, myAddress, sessionPurchasedIds]);

  // ── Build candidate listing IDs ───────────────────────────
  // If there's a contract search, restrict to listings tied to that contract's jobs.
  const candidateIds = useMemo(() => {
    const trimmed = contractSearch.trim().toLowerCase();
    if (!trimmed) return Object.keys(dataListings);

    const matchJobIds = Object.entries(activeJobs)
      .filter(([, job]) => job.contractAddress?.toLowerCase() === trimmed)
      .map(([jobId]) => jobId);

    if (matchJobIds.length === 0) return [];
    return matchJobIds.flatMap((jid) => jobListings[jid] || []).map(String);
  }, [contractSearch, dataListings, activeJobs, jobListings]);

  // ── Apply filters + sort ──────────────────────────────────
  const displayedListings = useMemo(() => {
    let list = candidateIds
      .map((id) => dataListings[id])
      .filter(Boolean)
      .filter((l) => l.active !== false)
      // Only human-relevant categories
      .filter((l) => HUMAN_CATEGORY_IDS.has(Number(l.category ?? 0)));

    if (catFilter !== null) {
      list = list.filter((l) => Number(l.category ?? 0) === catFilter);
    }
    if (typeFilter !== null) {
      list = list.filter((l) => Number(l.listingType ?? 0) === typeFilter);
    }
    if (ratingMin !== null) {
      list = list.filter((l) => {
        const r = ratings[l.listingId?.toString()];
        return r ? r.avg >= ratingMin : false;
      });
    }
    if (priceSort === 'asc') {
      list = [...list].sort((a, b) => Number(a.price ?? 0) - Number(b.price ?? 0));
    } else if (priceSort === 'desc') {
      list = [...list].sort((a, b) => Number(b.price ?? 0) - Number(a.price ?? 0));
    } else {
      // Default: newest first (by listingId descending or listedAt)
      list = [...list].sort((a, b) => (b.listingId > a.listingId ? 1 : -1));
    }
    if (showMineOnly) {
      if (!myAddress) return [];
      list = list.filter((l) => {
        const key = l.parentJobId != null ? String(l.parentJobId) : '';
        const m = reportMeta[key];
        return m?.deployer?.toLowerCase() === myAddress?.toLowerCase();
      });
    }
    return list;
  }, [candidateIds, dataListings, catFilter, typeFilter, ratingMin, priceSort, ratings, showMineOnly, reportMeta, myAddress]);

  // Per-category counts (unfiltered, for pills)
  const categoryCounts = useMemo(() => {
    const counts = {};
    candidateIds.forEach((id) => {
      const l = dataListings[id];
      if (!l || l.active === false) return;
      if (!HUMAN_CATEGORY_IDS.has(Number(l.category ?? 0))) return;
      const catId = String(l.category ?? 0);
      counts[catId] = (counts[catId] || 0) + 1;
    });
    return counts;
  }, [candidateIds, dataListings]);

  const handlePurchaseSuccess = (listingId) => {
    setSessionPurchasedIds((prev) => new Set([...prev, listingId?.toString()]));
    setPurchaseModal(null);
  };

  return (
    <div className="min-h-screen flex flex-col bg-black text-gray-100">
      <Header />

      {/* ── Sub-header ── */}
      <div className="flex-shrink-0 flex items-center gap-4 px-5 py-3 border-b border-gray-900 bg-black">
        <Link
          to="/dashboard"
          className="text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← Dashboard
        </Link>
        <div className="h-4 w-px bg-gray-800" />
        <div>
          <h1 className="text-sm font-bold font-mono uppercase tracking-widest text-gray-100">
            📄 Audit Report Marketplace
          </h1>
          <p className="text-[11px] font-mono text-gray-500">
            Purchase security reports produced by autonomous agents
          </p>
        </div>
        <div className="ml-auto">
          <WalletButton />
        </div>
      </div>

      {/* ── Search + Filters ── */}
      <div className="flex-shrink-0 px-5 py-4 border-b border-gray-900 space-y-3">
        {/* Contract address search */}
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">🔍</span>
          <input
            type="text"
            value={contractSearch}
            onChange={(e) => updateContractSearch(e.target.value)}
            placeholder="Find reports for your contract: 0x…"
            className="w-full bg-gray-900/60 border border-gray-900 rounded-lg pl-9 pr-4 py-2.5 text-sm font-mono text-gray-100 placeholder-gray-600 focus:outline-none focus:border-guard-amber transition-colors"
          />
          {contractSearch && (
            <button
              type="button"
              onClick={() => updateContractSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              ×
            </button>
          )}
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Category pills */}
          {HUMAN_FILTER_TABS.map((tab) => {
            const count = tab.id === null
              ? Object.values(categoryCounts).reduce((a, b) => a + b, 0)
              : categoryCounts[String(tab.id)] || 0;
            return (
              <FilterPill
                key={tab.key}
                icon={tab.icon}
                label={tab.label}
                active={catFilter === tab.id}
                count={tab.id !== null ? count : null}
                onClick={() => setCatFilter(catFilter === tab.id ? null : tab.id)}
              />
            );
          })}

          <div className="w-px h-5 bg-gray-700 mx-1" />

          {/* Type filter */}
          <FilterPill
            label="One-Time"
            active={typeFilter === 0}
            onClick={() => setTypeFilter(typeFilter === 0 ? null : 0)}
          />
          <FilterPill
            label="Subscription"
            active={typeFilter === 1}
            onClick={() => setTypeFilter(typeFilter === 1 ? null : 1)}
          />

          <div className="w-px h-5 bg-gray-700 mx-1" />

          {/* Price sort */}
          <FilterPill
            label="Price ↑"
            active={priceSort === 'asc'}
            onClick={() => setPriceSort(priceSort === 'asc' ? null : 'asc')}
          />
          <FilterPill
            label="Price ↓"
            active={priceSort === 'desc'}
            onClick={() => setPriceSort(priceSort === 'desc' ? null : 'desc')}
          />

          <div className="w-px h-5 bg-gray-700 mx-1" />

          {/* Rating filter */}
          <FilterPill
            label="★ 4+"
            active={ratingMin === 4}
            onClick={() => setRatingMin(ratingMin === 4 ? null : 4)}
          />
          <FilterPill
            label="★ 3+"
            active={ratingMin === 3}
            onClick={() => setRatingMin(ratingMin === 3 ? null : 3)}
          />
        </div>

        {/* Results count */}
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-mono text-gray-600">
            {displayedListings.length} report{displayedListings.length !== 1 ? 's' : ''} found
            {contractSearch && (
              <span className="ml-1 text-guard-amber">
                for <span className="font-semibold">{fmt.address(contractSearch)}</span>
              </span>
            )}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '0px' }}>
            <button
              type="button"
              onClick={() => setShowMineOnly(false)}
              style={{ opacity: showMineOnly ? 0.5 : 1 }}
              className="text-[11px] font-mono px-2 py-1 rounded border border-gray-700 text-gray-300"
            >
              All Reports
            </button>
            <button
              type="button"
              onClick={() => setShowMineOnly(true)}
              style={{ opacity: showMineOnly ? 1 : 0.5 }}
              className="text-[11px] font-mono px-2 py-1 rounded border border-gray-700 text-gray-300"
            >
              My Contracts
            </button>
          </div>
          {(catFilter !== null || typeFilter !== null || priceSort !== null || ratingMin !== null || contractSearch) && (
            <button
              type="button"
              onClick={() => {
                setCatFilter(null); setTypeFilter(null);
                setPriceSort(null); setRatingMin(null);
                updateContractSearch('');
                setShowMineOnly(false);
              }}
              className="text-[11px] font-mono text-gray-500 hover:text-gray-300"
            >
              Clear filters ×
            </button>
          )}
        </div>
        {showMineOnly && !myAddress && (
          <p className="text-[11px] font-mono text-amber-300">
            Connect your wallet to see reports for your contracts.
          </p>
        )}
      </div>

      {/* ── Main content ── */}
      <main className="flex-1 px-5 py-6">
        <section className="mb-8">
          <div className="rounded-xl border border-gray-800 bg-gray-950/70 p-4 md:p-5">
            <h2 className="text-sm font-bold font-mono uppercase tracking-widest text-gray-100">
              My Audit Reports
            </h2>
            <p className="text-xs font-mono text-gray-500 mt-1">
              Reports generated for contracts deployed by your connected wallet.
            </p>
            <div className="mt-4">
              <UserReportList />
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <AnimatePresence initial={false}>
            {displayedListings.length === 0 ? (
              <EmptyState contractSearch={contractSearch} />
            ) : (
              displayedListings.map((listing) => {
                const lid = listing.listingId?.toString();
                return (
                  <ReportCard
                    key={lid}
                    listing={listing}
                    hasAccess={accessSet.has(lid)}
                    rating={ratings[lid] || null}
                    onPurchase={() => setPurchaseModal(listing)}
                    onView={() => setViewerListing(listing)}
                  />
                );
              })
            )}
          </AnimatePresence>
        </div>

        {/* ── Purchase history ── */}
        <PurchaseHistory
          sessionPurchasedIds={sessionPurchasedIds}
          onView={setViewerListing}
        />
      </main>

      {/* ── Modals ── */}
      {purchaseModal && (
        <PurchaseModal
          listing={purchaseModal}
          onClose={() => setPurchaseModal(null)}
          onSuccess={handlePurchaseSuccess}
        />
      )}
      {viewerListing && (
        <ReportViewer
          listing={viewerListing}
          onClose={() => setViewerListing(null)}
        />
      )}
    </div>
  );
}
