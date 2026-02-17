import { useEffect } from 'react';
import { initializeConnection } from '../services/hedera-connection';
import useStore from '../store';

/**
 * Hook that initialises the Hedera connection layer and pushes the result
 * into the Zustand store.  Returns the connection slice of the store.
 */
export function useConnection() {
  const {
    isConnected,
    connectionError,
    config,
    contracts,
    ethersProvider,
    hederaClient,
    setConnected,
    setConnectionError,
  } = useStore();

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const result = await initializeConnection();
        if (!cancelled) {
          setConnected(
            result.config,
            result.contracts,
            result.hederaClient,
            result.ethersProvider,
          );
        }
      } catch (err) {
        console.error('[useConnection] Init failed:', err);
        if (!cancelled) setConnectionError(err.message);
      }
    }

    if (!isConnected && !connectionError) init();

    return () => { cancelled = true; };
  }, []); // run once on mount

  return { isConnected, connectionError, config, contracts, ethersProvider, hederaClient };
}
