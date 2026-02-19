import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import useWalletStore from '../../store/wallet';

function WalletOption({ title, subtitle, icon, onClick, disabled = false, accent = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'w-full rounded-lg border px-4 py-3 text-left transition-colors',
        disabled
          ? 'border-gray-800 bg-gray-900/70 text-gray-500 cursor-not-allowed'
          : accent
          ? 'border-guard-amber/50 bg-guard-amber/10 hover:bg-guard-amber/20'
          : 'border-gray-700 bg-gray-900 hover:border-gray-500',
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        <span className="text-lg">{icon}</span>
        <div>
          <p className="font-mono text-sm font-semibold text-gray-100">{title}</p>
          <p className="text-xs text-gray-400">{subtitle}</p>
        </div>
      </div>
    </button>
  );
}

function NetworkConfigHelp() {
  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-3 text-[11px] text-gray-400">
      <p className="mb-1 font-mono uppercase tracking-wider text-gray-300">MetaMask Hedera Testnet</p>
      <p>Network Name: Hedera Testnet</p>
      <p>RPC URL: https://testnet.hashio.io/api</p>
      <p>Chain ID: 296</p>
      <p>Currency Symbol: HBAR</p>
      <p>Block Explorer: https://hashscan.io/testnet</p>
    </div>
  );
}

export default function WalletConnectModal() {
  const navigate = useNavigate();
  const isModalOpen = useWalletStore((s) => s.isModalOpen);
  const modalContext = useWalletStore((s) => s.modalContext);
  const connectionStatus = useWalletStore((s) => s.connectionStatus);
  const error = useWalletStore((s) => s.error);
  const connect = useWalletStore((s) => s.connect);
  const closeWalletModal = useWalletStore((s) => s.closeWalletModal);
  const [showConfigHelp, setShowConfigHelp] = useState(false);

  const isConnecting = connectionStatus === 'connecting';

  const handleConnectMetaMask = async () => {
    const ok = await connect('metamask');
    if (ok) navigate('/dashboard');
  };

  const handleContinueWithoutWallet = () => {
    closeWalletModal();
    navigate('/dashboard');
  };

  if (!isModalOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4"
        onClick={closeWalletModal}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 12 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.98, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-xl rounded-xl border border-gray-700 bg-gray-950 p-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <h2 className="font-mono text-base font-bold uppercase tracking-wider text-gray-100">
                Connect Your Wallet
              </h2>
              {modalContext?.message && (
                <p className="mt-1 text-xs text-gray-400">{modalContext.message}</p>
              )}
            </div>
            <button
              type="button"
              onClick={closeWalletModal}
              className="text-gray-500 hover:text-gray-200"
            >
              x
            </button>
          </div>

          <div className="space-y-3">
            <WalletOption
              title="MetaMask"
              subtitle="Connect via Hedera EVM relay"
              icon="🦊"
              accent
              onClick={handleConnectMetaMask}
              disabled={isConnecting}
            />

            <WalletOption
              title="HashPack"
              subtitle="HashPack support coming soon"
              icon="#"
              onClick={() => {}}
              disabled
            />
          </div>

          <div className="my-4 flex items-center gap-3 text-xs text-gray-500">
            <span className="h-px flex-1 bg-gray-800" />
            <span>or</span>
            <span className="h-px flex-1 bg-gray-800" />
          </div>

          <button
            type="button"
            className="text-sm text-guard-amber hover:text-amber-300"
            onClick={handleContinueWithoutWallet}
          >
            Continue without wallet {'->'}
          </button>
          <p className="text-xs text-gray-500">(view-only mode)</p>

          <button
            type="button"
            className="mt-4 text-xs text-gray-500 underline hover:text-gray-300"
            onClick={() => setShowConfigHelp((v) => !v)}
          >
            {showConfigHelp ? 'Hide MetaMask network config' : 'Show MetaMask network config'}
          </button>

          {showConfigHelp && <div className="mt-3"><NetworkConfigHelp /></div>}

          {error && (
            <div className="mt-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
