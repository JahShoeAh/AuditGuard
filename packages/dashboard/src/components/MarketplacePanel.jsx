import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import useStore from '../store';
import { useMarketplaceData } from '../hooks/useMarketplaceData';
import MarketplaceListingRow from './MarketplaceListingRow';
import { useAutoScroll } from '../hooks/useAutoScroll';

// ── Category filter tabs ──────────────────────────────────────

const TABS = [
  { key: 'ALL',                label: 'ALL',      icon: '◈' },
  { key: 'SCAN_REPORT',        label: 'SCAN',     icon: '📄' },
  { key: 'DEPENDENCY_ANALYSIS',label: 'DEP',      icon: '🌳' },
  { key: 'EXPLOIT_DATABASE',   label: 'EXPLOIT',  icon: '🛡' },
  { key: 'HOT_LEAD',           label: 'HOT LEAD', icon: '📡' },
  { key: 'FUZZING_SEEDS',      label: 'FUZZ',     icon: '🐛' },
  { key: 'THREAT_INTEL',       label: 'INTEL',    icon: '⚠' },
];

const DATA_CATEGORIES = [
  'SCAN_REPORT', 'DEPENDENCY_ANALYSIS', 'EXPLOIT_DATABASE',
  'HOT_LEAD', 'FUZZING_SEEDS', 'THREAT_INTEL',
];

// ── Purchase toast ───────────────────────────────────────────

function PurchaseToast({ toast }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, height: 0 }}
      transition={{ duration: 0.18 }}
      className="flex items-center gap-2 px-3 py-1.5 rounded text-[10px] font-mono mx-2 mt-1"
      style={{
        background: 'rgba(217,119,6,0.12)',
        border: '1px solid rgba(217,119,6,0.25)',
      }}
    >
      <span style={{ color: 'var(--accent-gold)' }}>⚡</span>
      <span className="text-gray-300 truncate">{toast.message}</span>
    </motion.div>
  );
}

// ── Empty state ───────────────────────────────────────────────

function EmptyMarketplace() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
      <motion.div
        animate={{ opacity: [0.3, 0.7, 0.3], scale: [1, 1.05, 1] }}
        transition={{ duration: 3.5, repeat: Infinity }}
        className="text-3xl"
      >
        📂
      </motion.div>
      <p className="text-[11px] text-gray-600 font-mono leading-relaxed">
        No data listings yet…
        <br />
        Agents will list reports as audits complete.
      </p>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────

export default function MarketplacePanel() {
  const [activeTab, setActiveTab]   = useState('ALL');
  const [toasts, setToasts]         = useState([]);
  const [newIds, setNewIds]         = useState(new Set());

  const dataPurchases = useStore((s) => s.dataPurchases);
  const dataListings  = useStore((s) => s.dataListings);

  // Derive category filter index
  const categoryFilter = activeTab === 'ALL'
    ? null
    : DATA_CATEGORIES.indexOf(activeTab);

  const { listings, categoryCounts, missedCount } = useMarketplaceData(
    categoryFilter === -1 ? null : categoryFilter
  );
  const { containerRef: listRef } = useAutoScroll(listings.length);

  // ── Track new listings for slide-in animation ──
  const prevListingIdsRef = useRef(new Set());
  useEffect(() => {
    const currentIds = new Set(Object.keys(dataListings));
    const fresh = new Set();
    for (const id of currentIds) {
      if (!prevListingIdsRef.current.has(id)) fresh.add(id);
    }
    if (fresh.size > 0) {
      setNewIds(fresh);
      setTimeout(() => setNewIds(new Set()), 2500);
    }
    prevListingIdsRef.current = currentIds;
  }, [dataListings]);

  // ── Show toast on new purchase ──
  const prevPurchaseCountRef = useRef(0);
  useEffect(() => {
    if (dataPurchases.length > prevPurchaseCountRef.current) {
      const latest = dataPurchases[0];
      if (latest) {
        const listing = dataListings[latest.listingId];
        const message = `${latest.buyerName || '?'} purchased "${listing?.title || '?'}" for ${latest.pricePaidFormatted}`;
        const id = Date.now();
        setToasts((prev) => [{ id, message }, ...prev].slice(0, 3));
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
      }
      prevPurchaseCountRef.current = dataPurchases.length;
    }
  }, [dataPurchases, dataListings]);

  return (
    <div className="panel flex flex-col h-full">
      {/* ── Header ── */}
      <div className="px-4 py-2.5 border-b border-white/[0.04] flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] leading-none" style={{ color: '#14b8a6' }}>⟳</span>
            <h2
              className="text-xs font-semibold tracking-wider uppercase font-sans"
              style={{ color: '#14b8a6' }}
            >
              Data Marketplace
            </h2>
            <span className="text-[10px] text-gray-600 font-mono">
              ({listings.length} active)
            </span>
          </div>
          <div className="flex items-center gap-2">
            {missedCount > 0 && (
              <span className="text-[9px] font-mono" style={{ color: 'var(--accent-amber)' }}>
                +{missedCount} missed
              </span>
            )}
            <Link
              to="/dashboard/reports"
              className="text-[9px] font-mono text-cyan-500 hover:text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 rounded hover:border-cyan-500/60 transition-colors whitespace-nowrap"
            >
              Buy reports →
            </Link>
          </div>
        </div>
      </div>

      {/* ── Purchase toasts ── */}
      <AnimatePresence>
        {toasts.map((t) => (
          <PurchaseToast key={t.id} toast={t} />
        ))}
      </AnimatePresence>

      {/* ── Category filter tabs ── */}
      <div className="px-2 py-1.5 border-b border-white/[0.04] flex-shrink-0 overflow-x-auto scrollbar-hide">
        <div className="flex items-center gap-1 min-w-max">
          {TABS.map((tab) => {
            const count = categoryCounts[tab.key] || 0;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono whitespace-nowrap transition-all"
                style={{
                  background: isActive ? 'rgba(20,184,166,0.14)' : 'rgba(255,255,255,0.03)',
                  color: isActive ? '#14b8a6' : '#6b7280',
                  border: isActive ? '1px solid rgba(20,184,166,0.3)' : '1px solid transparent',
                }}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
                {count > 0 && (
                  <span
                    className="px-1 rounded-full text-[8px] font-bold"
                    style={{
                      background: isActive ? 'rgba(20,184,166,0.25)' : 'rgba(255,255,255,0.08)',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Listing rows ── */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {listings.length === 0 ? (
          <EmptyMarketplace />
        ) : (
          <AnimatePresence initial={false}>
            {listings.map((listing) => (
              <MarketplaceListingRow
                key={listing.listingId}
                listing={listing}
                isNew={newIds.has(listing.listingId)}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
