import useWalletStore from '../../store/wallet';

export default function WalletGate({ children, fallback = null }) {
  const connected = useWalletStore((s) => s.connectionStatus === 'connected');
  return connected ? children : fallback;
}
