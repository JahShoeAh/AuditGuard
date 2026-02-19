import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { ethers } from 'ethers';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import { useContractWrite } from '../../hooks/useContractWrite';
import { fmt } from '../../utils/format';
import { fmtGuard, CATEGORY_META, starsFromRating } from './reportConstants';
import { hashscan } from '../../utils/hashscan';

// ── Mock findings for demo ─────────────────────────────────

function mockFindings(category) {
  const catId = Number(category ?? 0);
  if (catId === 6) { // AUDIT_FINDING
    return [
      { severity: 'HIGH',   id: 'AF-001', title: 'Reentrancy in withdraw()',         line: 142 },
      { severity: 'MEDIUM', id: 'AF-002', title: 'Unchecked external call return',   line: 89  },
      { severity: 'LOW',    id: 'AF-003', title: 'Missing event emission on state change', line: 204 },
      { severity: 'INFO',   id: 'AF-004', title: 'Use of block.timestamp for randomness', line: 317 },
    ];
  }
  if (catId === 1) { // DEPENDENCY_ANALYSIS
    return [
      { severity: 'HIGH',   id: 'DA-001', title: 'OpenZeppelin 4.7.x ECDSA vulnerability', line: null },
      { severity: 'MEDIUM', id: 'DA-002', title: 'Outdated Solidity compiler (0.8.10)',     line: null },
      { severity: 'LOW',    id: 'DA-003', title: 'Unlocked dependency version range',       line: null },
    ];
  }
  if (catId === 5) { // THREAT_INTEL
    return [
      { severity: 'HIGH',   id: 'TI-001', title: 'Pattern match: flash loan + re-entry combo', line: null },
      { severity: 'MEDIUM', id: 'TI-002', title: 'Known MEV-susceptible swap path',            line: null },
    ];
  }
  // SCAN_REPORT (0) or default
  return [
    { severity: 'MEDIUM', id: 'SR-001', title: 'Integer overflow in fee calculation',    line: 77  },
    { severity: 'LOW',    id: 'SR-002', title: 'Divide-before-multiply precision loss',   line: 133 },
    { severity: 'LOW',    id: 'SR-003', title: 'Unused return value from transfer()',     line: 201 },
    { severity: 'INFO',   id: 'SR-004', title: 'Magic number without constant name',      line: 55  },
  ];
}

// ── Severity badge ─────────────────────────────────────────

const SEV_STYLE = {
  HIGH:   'bg-red-900/50 text-red-300 border-red-500/50',
  MEDIUM: 'bg-amber-900/50 text-amber-300 border-amber-500/50',
  LOW:    'bg-blue-900/50 text-blue-300 border-blue-500/50',
  INFO:   'bg-gray-800 text-gray-400 border-gray-700',
};

function SeverityBadge({ severity }) {
  return (
    <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${SEV_STYLE[severity] ?? SEV_STYLE.INFO}`}>
      {severity}
    </span>
  );
}

// ── Interactive star picker ────────────────────────────────

function StarPicker({ value, onChange }) {
  const [hovered, setHovered] = useState(null);
  const display = hovered ?? value ?? 0;
  return (
    <div className="flex gap-1" onMouseLeave={() => setHovered(null)}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onMouseEnter={() => setHovered(star)}
          onClick={() => onChange(star)}
          className={`text-xl transition-colors ${display >= star ? 'text-amber-400' : 'text-gray-700'} hover:text-amber-300`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// ── ReportViewer ───────────────────────────────────────────

/**
 * Props:
 *   listing       DataListing object
 *   onClose       () => void
 */
export default function ReportViewer({ listing, onClose }) {
  const contracts = useStore((s) => s.contracts);
  const reportMeta = useStore((s) => s.reportMetadata);
  const address   = useWalletStore((s) => s.address);
  const connectionStatus = useWalletStore((s) => s.connectionStatus);
  const purchases = useStore((s) => s.dataPurchases);
  const updateRating = useStore((s) => s.updateDataPurchaseRating);

  const { execute: execWrite } = useContractWrite();

  const parentJobKey = listing?.parentJobId != null ? String(listing.parentJobId) : null;
  const meta = parentJobKey ? reportMeta[parentJobKey] : null;

  const myPurchase   = purchases.find(
    (p) => p.listingId === listing.listingId && p.buyer?.toLowerCase() === address?.toLowerCase()
  );
  const existingRating = myPurchase?.rating ?? null;
  const hasPurchased = !!myPurchase;
  const isDeployer = !!(meta?.deployer && address && meta.deployer.toLowerCase() === address.toLowerCase());
  const canView = isDeployer || hasPurchased;

  const [reportContent, setReportContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [verified, setVerified] = useState(null);

  const [rating,       setRating]       = useState(existingRating);
  const [ratingSubmitted, setSubmitted] = useState(!!existingRating);
  const [submitting,   setSubmitting]   = useState(false);

  const findings  = mockFindings(listing.category);
  const catMeta   = CATEGORY_META[Number(listing.category ?? 0)] ?? CATEGORY_META[7];
  const countBySev = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  const shouldAttemptIPFS = canView && !!meta?.cid;
  const showMarkdown = canView && !!reportContent && !!meta?.cid;
  const showFallback = canView && (!shouldAttemptIPFS || !!error || (!reportContent && !loading));

  useEffect(() => {
    let cancelled = false;

    if (!canView || !meta?.cid) {
      setReportContent(null);
      setVerified(null);
      setError(null);
      setLoading(false);
      return () => {};
    }

    setLoading(true);
    setError(null);
    fetch(`http://localhost:8080/ipfs/${meta.cid}`)
      .then((res) => {
        if (!res.ok) throw new Error(`IPFS: ${res.status}`);
        return res.text();
      })
      .then((content) => {
        if (cancelled) return;
        setReportContent(content);
        const hash = ethers.keccak256(ethers.toUtf8Bytes(content));
        setVerified(hash === meta.contentHash);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || String(err));
        setReportContent(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [canView, meta?.cid, meta?.contentHash]);

  const handleSubmitRating = useCallback(async () => {
    if (!rating || submitting || ratingSubmitted) return;
    const mkt = contracts?.dataMarketplaceContract;
    try {
      setSubmitting(true);
      if (mkt) {
        await execWrite(mkt, 'ratePurchase', [listing.listingId, rating]);
      }
      updateRating(listing.listingId, address, rating);
      setSubmitted(true);
    } catch {
      // silently swallow — rating is non-critical
      updateRating(listing.listingId, address, rating);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }, [rating, submitting, ratingSubmitted, contracts, execWrite, listing.listingId, address, updateRating]);

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center px-4 py-6 overflow-y-auto"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          key="panel"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-2xl bg-gray-950 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="flex items-start justify-between p-5 border-b border-gray-800">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xl">{catMeta.icon}</span>
                <span className={`text-[10px] font-bold font-mono uppercase tracking-widest ${canView ? 'text-green-400' : 'text-amber-300'}`}>
                  {canView ? '✓ Report Access Granted' : 'Purchase Required'}
                </span>
              </div>
              <h2 className="text-sm font-bold font-mono text-gray-100 leading-snug">
                {listing.title}
              </h2>
              <p className="text-xs font-mono text-gray-500 mt-0.5">
                By: {listing.sellerName || fmt.address(listing.seller)}
                {' · '}
                {fmtGuard(listing.price)} GUARD
              </p>
            </div>
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 text-xl flex-shrink-0 ml-4">×</button>
          </div>

          {/* ── Content ── */}
          <div className="p-5 space-y-5">
            {!canView && (
              <div className="border border-amber-500/30 rounded-xl p-4 bg-amber-500/5">
                <p className="text-[10px] font-bold font-mono uppercase tracking-widest text-amber-300 mb-2">
                  Access Required
                </p>
                {connectionStatus === 'connected' ? (
                  <p className="text-[12px] font-mono text-gray-300">
                    Purchase this report to view full content. Deployer accounts can view it without purchase.
                  </p>
                ) : (
                  <p className="text-[12px] font-mono text-gray-300">
                    Connect your wallet to purchase this report or unlock deployer access.
                  </p>
                )}
              </div>
            )}

            {canView && loading && (
              <div className="border border-cyan-500/30 rounded-xl p-4 bg-cyan-500/5">
                <p className="text-sm font-mono text-cyan-300">Loading report from IPFS...</p>
              </div>
            )}

            {canView && error && (
              <div className="border border-red-500/30 rounded-xl p-4 bg-red-500/5">
                <p className="text-sm font-mono text-red-300">
                  Failed to load: {error}. Falling back to listing data.
                </p>
              </div>
            )}

            {showMarkdown && (
              <div className="border border-green-500/20 rounded-xl p-4 bg-gray-900">
                {verified === true && (
                  <span style={{ color: '#10B981' }} className="text-xs font-mono">
                    ✓ Content verified on-chain
                  </span>
                )}
                {verified === false && (
                  <span style={{ color: '#EF4444' }} className="text-xs font-mono">
                    ⚠ Hash mismatch
                  </span>
                )}
                <div className="prose prose-invert max-w-none mt-3">
                  <ReactMarkdown>{reportContent}</ReactMarkdown>
                </div>
              </div>
            )}

            {showFallback && (
              <>
                {/* Verification block */}
                <div className="border border-cyan-500/20 rounded-xl p-4 bg-cyan-500/5">
                  <p className="text-[10px] font-bold font-mono uppercase tracking-widest text-cyan-500 mb-2">
                    Data Provenance
                  </p>
                  <p className="text-[11px] font-mono text-gray-400 leading-relaxed">
                    This report&apos;s content is stored on the{' '}
                    <span className="text-cyan-400">0g Labs DA layer</span> and verified by the
                    on-chain content hash below.
                  </p>
                  {(meta?.contentHash || listing.contentHash) && (
                    <div className="mt-2">
                      <p className="text-[10px] font-mono text-gray-600 mb-0.5">Content hash</p>
                      <p className="text-[11px] font-mono text-cyan-500 break-all">
                        {meta?.contentHash || listing.contentHash}
                      </p>
                    </div>
                  )}
                  <div className="flex gap-3 mt-3">
                    <a
                      href={hashscan.transaction(listing._tx?.txId || (meta?.contentHash || listing.contentHash)?.slice(2, 18) || '')}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-mono text-cyan-400 hover:text-cyan-200 hover:underline"
                    >
                      View on HashScan ↗
                    </a>
                  </div>
                </div>

                {/* Finding summary */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-bold font-mono uppercase tracking-widest text-gray-400">
                      Findings Summary
                    </p>
                    <div className="flex gap-2">
                      {Object.entries(countBySev).map(([sev, count]) => (
                        <span key={sev} className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${SEV_STYLE[sev] ?? SEV_STYLE.INFO}`}>
                          {count} {sev}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {findings.map((f) => (
                      <div key={f.id} className="flex items-start gap-3 border border-gray-800 rounded-lg p-3 bg-gray-900">
                        <SeverityBadge severity={f.severity} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-mono font-semibold text-gray-200">{f.id} — {f.title}</p>
                          {f.line && (
                            <p className="text-[10px] font-mono text-gray-600 mt-0.5">Line {f.line}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="text-[10px] font-mono text-gray-700 mt-3">
                    * This is a demo summary. In production, the full report is fetched from the 0g Labs DA
                    layer using the content hash above.
                  </p>
                </div>
              </>
            )}

            {/* Agent info */}
            <div className="flex items-center gap-3 border border-gray-800 rounded-xl p-3 bg-gray-900">
              <span className="text-2xl">🤖</span>
              <div>
                <p className="text-xs font-mono font-semibold text-gray-200">
                  {listing.sellerName || fmt.address(listing.seller)}
                </p>
                <p className="text-[11px] font-mono text-gray-500">Autonomous security agent</p>
              </div>
              <Link
                to={`/dashboard?agent=${listing.seller}`}
                className="ml-auto text-[11px] font-mono text-cyan-400 hover:text-cyan-200"
                onClick={onClose}
              >
                View agent profile →
              </Link>
            </div>

            {/* Rating section */}
            {canView && (
              <div className="border border-gray-700 rounded-xl p-4 bg-gray-900">
                <p className="text-xs font-bold font-mono uppercase tracking-widest text-gray-400 mb-3">
                  Rate This Report
                </p>
                {ratingSubmitted ? (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-sm font-mono text-green-400"
                  >
                    ★ Thanks for your rating! Your feedback helps the marketplace.
                  </motion.p>
                ) : (
                  <div className="flex items-center gap-4">
                    <StarPicker value={rating} onChange={setRating} />
                    <button
                      type="button"
                      onClick={handleSubmitRating}
                      disabled={!rating || submitting}
                      className="text-xs font-bold font-mono uppercase tracking-wider px-3 py-1.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {submitting ? 'Submitting…' : 'Submit Rating'}
                    </button>
                  </div>
                )}
              </div>
            )}

          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
