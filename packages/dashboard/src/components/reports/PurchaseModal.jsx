import { useState } from 'react';
import { Contract } from 'ethers';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import { loadConfig } from '../../services/hedera-connection';
import { fmt } from '../../utils/format';
import { fmtGuard, platformFee, CATEGORY_META } from './reportConstants';

// ── ERC-20 ABI minimal ─────────────────────────────────────

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// ── Tx phase states ────────────────────────────────────────

const PHASE = {
  IDLE:       'idle',
  APPROVING:  'approving',
  PURCHASING: 'purchasing',
  SUCCESS:    'success',
  ERROR:      'error',
};

// ── TxRow ──────────────────────────────────────────────────

function TxRow({ label, done, active }) {
  return (
    <div className={[
      'flex items-center gap-2 text-xs font-mono',
      done   ? 'text-green-400' :
      active ? 'text-cyan-300 animate-pulse' :
               'text-gray-600',
    ].join(' ')}>
      <span className="w-4 flex-shrink-0">
        {done ? '✓' : active ? '⏳' : '○'}
      </span>
      {label}
    </div>
  );
}

// ── PurchaseModal ──────────────────────────────────────────

/**
 * Props:
 *   listing     DataListing object
 *   onClose     () => void
 *   onSuccess   (listingId) => void   — called when purchase confirms
 */
export default function PurchaseModal({ listing, onClose, onSuccess }) {
  const contracts    = useStore((s) => s.contracts);
  const signer       = useWalletStore((s) => s.signer);
  const address      = useWalletStore((s) => s.address);
  const guardBalance = useWalletStore((s) => s.guardBalance);
  const refreshBal   = useWalletStore((s) => s.refreshBalances);
  const addPurchase  = useStore((s) => s.addDataPurchase);

  const [phase, setPhase] = useState(PHASE.IDLE);
  const [errMsg, setErrMsg] = useState('');

  const priceRaw   = listing.price ? BigInt(listing.price.toString()) : 0n;
  const feeRaw     = platformFee(priceRaw);
  const totalRaw   = priceRaw + feeRaw;
  const balance    = parseFloat(guardBalance) || 0;
  const balanceRaw = BigInt(Math.floor(balance * 1e8));
  const canAfford  = balanceRaw >= totalRaw;
  const afterBal   = Math.max(0, balance - parseFloat(fmtGuard(totalRaw)));

  const catMeta = CATEGORY_META[Number(listing.category ?? 0)] ?? CATEGORY_META[7];
  const isRunning = phase === PHASE.APPROVING || phase === PHASE.PURCHASING;

  const handlePurchase = async () => {
    const marketplace = contracts?.dataMarketplaceContract;
    if (!marketplace || !signer || !address) {
      setErrMsg('Wallet or contracts not ready. Try refreshing.');
      setPhase(PHASE.ERROR);
      return;
    }
    setErrMsg('');

    try {
      // ── 1/2: Approve GUARD ───────────────────────────────
      setPhase(PHASE.APPROVING);
      const config      = loadConfig();
      const guardToken  = new Contract(config.guardTokenEvmAddress, ERC20_ABI, signer);
      const mktAddr     = await marketplace.getAddress();
      const allowance   = await guardToken.allowance(address, mktAddr);
      if (allowance < totalRaw) {
        const tx = await guardToken.approve(mktAddr, totalRaw);
        await tx.wait();
      }

      // ── 2/2: Purchase ────────────────────────────────────
      setPhase(PHASE.PURCHASING);
      const writableMkt = marketplace.connect(signer);
      const purchaseTx  = await writableMkt.purchaseData(listing.listingId);
      await purchaseTx.wait();

      // Record in store
      addPurchase({
        listingId:         listing.listingId,
        buyer:             address,
        buyerName:         'You',
        pricePaidFormatted: fmtGuard(priceRaw) + ' GUARD',
        title:             listing.title,
        sellerName:        listing.sellerName,
        timestamp:         Date.now(),
        rating:            null,
      });

      setPhase(PHASE.SUCCESS);
      refreshBal();
      setTimeout(() => onSuccess(listing.listingId), 1200);
    } catch (err) {
      setErrMsg(parseErr(err));
      setPhase(PHASE.ERROR);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center px-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          key="panel"
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 12 }}
          transition={{ duration: 0.18 }}
          className="w-full max-w-md bg-gray-950 border border-gray-700 rounded-2xl p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <div>
              <p className="text-[10px] font-bold font-mono uppercase tracking-widest text-gray-500 mb-1">
                {catMeta.icon} Purchase Audit Report
              </p>
              <h2 className="text-sm font-bold font-mono text-gray-100 leading-snug pr-4">
                {listing.title}
              </h2>
              <p className="text-xs font-mono text-gray-500 mt-0.5">
                By: {listing.sellerName || fmt.address(listing.seller)}
              </p>
            </div>
            <button
              onClick={onClose}
              disabled={isRunning}
              className="text-gray-600 hover:text-gray-300 text-lg flex-shrink-0 disabled:opacity-30"
            >
              ×
            </button>
          </div>

          {/* Cost breakdown */}
          <div className="border border-gray-800 rounded-xl p-4 bg-gray-900 mb-4 space-y-2">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-gray-500">Report price</span>
              <span className="text-amber-300 font-bold">{fmtGuard(priceRaw)} GUARD</span>
            </div>
            <div className="flex justify-between text-xs font-mono">
              <span className="text-gray-500">Platform fee (3%)</span>
              <span className="text-gray-400">{fmtGuard(feeRaw)} GUARD</span>
            </div>
            <div className="flex justify-between text-xs font-mono border-t border-gray-800 pt-2">
              <span className="text-gray-300 font-semibold">Total</span>
              <span className="text-amber-300 font-bold">{fmtGuard(totalRaw)} GUARD</span>
            </div>
            <div className="flex justify-between text-xs font-mono">
              <span className="text-gray-500">Your balance</span>
              <span className={canAfford ? 'text-gray-300' : 'text-red-400'}>{balance.toFixed(2)} GUARD</span>
            </div>
            <div className="flex justify-between text-xs font-mono">
              <span className="text-gray-500">After purchase</span>
              <span className={canAfford ? 'text-green-400' : 'text-red-400'}>
                {canAfford ? afterBal.toFixed(2) : '—'} GUARD
              </span>
            </div>
          </div>

          {/* Content hash */}
          {listing.contentHash && (
            <div className="border border-gray-800 rounded-xl p-3 bg-gray-900 mb-4">
              <p className="text-[10px] font-mono text-gray-600 mb-1">Content hash (0g Labs DA layer)</p>
              <p className="text-[11px] font-mono text-cyan-500 break-all">
                {listing.contentHash?.slice(0, 20)}…{listing.contentHash?.slice(-8)}
              </p>
              <p className="text-[10px] font-mono text-gray-700 mt-1">
                Verifiable on 0g Labs DA layer.
              </p>
            </div>
          )}

          {/* Tx progress */}
          <div className="space-y-1.5 mb-4">
            <TxRow
              label="1/2 — Approve GUARD transfer"
              done={phase === PHASE.PURCHASING || phase === PHASE.SUCCESS}
              active={phase === PHASE.APPROVING}
            />
            <TxRow
              label={`2/2 — Purchase "${listing.title?.slice(0, 30)}…"`}
              done={phase === PHASE.SUCCESS}
              active={phase === PHASE.PURCHASING}
            />
          </div>

          {/* Success */}
          {phase === PHASE.SUCCESS && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center py-2 text-sm font-mono text-green-400 mb-3"
            >
              ✓ Report purchased! You now have access.
            </motion.div>
          )}

          {/* Error */}
          {phase === PHASE.ERROR && errMsg && (
            <div className="border border-red-500/40 rounded-lg p-3 bg-red-500/5 mb-4">
              <p className="text-xs font-mono text-red-300">✗ {errMsg}</p>
            </div>
          )}

          {/* Balance warning */}
          {!canAfford && phase === PHASE.IDLE && (
            <div className="border border-red-500/30 rounded-lg p-3 bg-red-500/5 mb-4">
              <p className="text-xs font-mono text-red-300">
                Insufficient GUARD balance. You need {fmtGuard(totalRaw)} GUARD but have {balance.toFixed(2)} GUARD.
              </p>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isRunning}
              className="flex-1 py-2.5 rounded-lg border border-gray-700 text-xs font-mono text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-30 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePurchase}
              disabled={isRunning || !canAfford || phase === PHASE.SUCCESS}
              className={[
                'flex-1 py-2.5 rounded-lg text-xs font-bold font-mono uppercase tracking-wider transition-all',
                isRunning || !canAfford || phase === PHASE.SUCCESS
                  ? 'bg-gray-800 border border-gray-700 text-gray-600 cursor-not-allowed'
                  : 'bg-amber-500/15 border-2 border-amber-500/60 text-amber-300 hover:bg-amber-500/25',
              ].join(' ')}
            >
              {isRunning
                ? phase === PHASE.APPROVING   ? 'Approving…'
                : phase === PHASE.PURCHASING  ? 'Purchasing…'
                : '…'
                : `Purchase ${fmtGuard(totalRaw)} GUARD`}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── Error parser ───────────────────────────────────────────

function parseErr(err) {
  if (!err) return 'Unknown error';
  if (err.code === 4001 || err.code === 'ACTION_REJECTED') return 'Transaction rejected by user.';
  const msg = err?.reason || err?.message || '';
  if (msg.includes('insufficient') || msg.includes('balance')) return 'Insufficient GUARD balance.';
  if (msg.includes('already purchased')) return 'You have already purchased this report.';
  if (msg.includes('expired')) return 'This listing has expired.';
  if (msg.includes('sold out') || msg.includes('maxBuyers')) return 'This report is sold out.';
  return msg.slice(0, 120) || 'Transaction failed.';
}
