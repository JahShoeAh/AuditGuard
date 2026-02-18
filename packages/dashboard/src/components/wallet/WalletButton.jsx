import { useEffect, useRef, useState } from 'react';
import useWalletStore from '../../store/wallet';
import { hashscan } from '../../utils/hashscan';

function fmtBalance(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return '--';
  return Number(value).toFixed(digits);
}

export default function WalletButton() {
  const status = useWalletStore((s) => s.connectionStatus);
  const displayName = useWalletStore((s) => s.displayName);
  const address = useWalletStore((s) => s.address);
  const guardBalance = useWalletStore((s) => s.guardBalance);
  const hbarBalance = useWalletStore((s) => s.hbarBalance);
  const openWalletModal = useWalletStore((s) => s.openWalletModal);
  const refreshBalances = useWalletStore((s) => s.refreshBalances);
  const disconnect = useWalletStore((s) => s.disconnect);

  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const onClick = (event) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  if (!isConnected) {
    return (
      <button
        type="button"
        disabled={isConnecting}
        onClick={() => openWalletModal({ action: 'unlock interactive features' })}
        className="rounded-md border border-cyan-500/60 px-3 py-1.5 text-xs font-mono font-semibold uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-500/10 disabled:opacity-60"
      >
        {isConnecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-left transition-colors hover:bg-cyan-500/20"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-semibold text-cyan-200">{displayName}</span>
          <span className="font-mono text-[11px] text-amber-300">
            {fmtBalance(guardBalance)} GUARD
          </span>
          <span className="font-mono text-[10px] text-gray-400">
            {fmtBalance(hbarBalance, 3)} HBAR
          </span>
        </div>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-52 rounded-md border border-gray-700 bg-gray-950 p-1.5 shadow-xl">
          <a
            href={hashscan.account(address)}
            target="_blank"
            rel="noreferrer"
            className="block rounded px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            View on HashScan {'->'}
          </a>
          <button
            type="button"
            onClick={async () => {
              if (!address) return;
              await navigator.clipboard.writeText(address);
              setOpen(false);
            }}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800"
          >
            Copy Address
          </button>
          <button
            type="button"
            onClick={() => refreshBalances()}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800"
          >
            Refresh Balances
          </button>
          <button
            type="button"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
