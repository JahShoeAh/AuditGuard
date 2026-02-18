import { useNavigate } from 'react-router-dom';
import useWalletStore from '../store/wallet';

export function useRequireWallet() {
  const connectionStatus = useWalletStore((s) => s.connectionStatus);
  const address = useWalletStore((s) => s.address);
  const signer = useWalletStore((s) => s.signer);
  const openWalletModal = useWalletStore((s) => s.openWalletModal);
  const navigate = useNavigate();

  const isConnected = connectionStatus === 'connected';

  const requireWallet = (action = 'continue', options = {}) => {
    if (!isConnected) {
      openWalletModal({
        action,
        message: `Connect your wallet to ${action}.`,
      });
      if (options.redirectTo) navigate(options.redirectTo);
      return false;
    }
    return true;
  };

  return { isConnected, connectionStatus, address, signer, requireWallet };
}

export default useRequireWallet;
