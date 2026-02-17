import { useEffect, useRef } from 'react';
import { EventListenerService } from '../services/event-listener';
import { startMockEventStream } from '../services/mock-events';
import useStore from '../store';

/**
 * Manages the EventListenerService lifecycle.
 * When useMockEvents is true in the store, pumps fake data instead.
 */
export function useEventListeners(connection) {
  const { config, contracts, ethersProvider } = connection;
  const store = useStore();
  const cleanupRef = useRef(null);

  useEffect(() => {
    // Tear down previous listeners
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (!config) return;

    if (store.useMockEvents) {
      // ── Mock mode ──
      const stop = startMockEventStream(useStore.getState, config);
      cleanupRef.current = stop;
      console.log('[useEventListeners] Mock event stream started');
    } else if (contracts && ethersProvider) {
      // ── Live mode ──
      const storeActions = {
        addDiscovery:   useStore.getState().addDiscovery,
        addLogEntry:    useStore.getState().addLogEntry,
        setJob:         useStore.getState().setJob,
        addBid:         useStore.getState().addBid,
        setWinners:     useStore.getState().setWinners,
        setAgent:       useStore.getState().setAgent,
        incrementStat:  useStore.getState().incrementStat,
        get agents()    { return useStore.getState().agents; },
      };
      const service = new EventListenerService(config, contracts, storeActions, ethersProvider);
      const stop = service.startAll();
      cleanupRef.current = stop;
      console.log('[useEventListeners] Live event listeners started');
    }

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [config, contracts, ethersProvider, store.useMockEvents]);
}
