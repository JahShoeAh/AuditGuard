import { useEffect, useRef } from 'react';
import { EventListenerService } from '../services/event-listener';
import { startMockEventStream } from '../services/mock-events';
import { startOfflineReplay } from '../services/offline-replay';
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
      const useOfflineReplay = import.meta.env.VITE_OFFLINE_REPLAY === 'true';
      if (useOfflineReplay) {
        const stop = startOfflineReplay(useStore.getState);
        cleanupRef.current = stop;
        console.log('[useEventListeners] Offline replay started');
        return () => {
          if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
          }
        };
      }
      // ── Mock mode ──
      const stop = startMockEventStream(useStore.getState, config);
      cleanupRef.current = stop;
      console.log('[useEventListeners] Mock event stream started');
    } else if (contracts && ethersProvider) {
      // ── Live mode ──
      const storeActions = {
        // Day 1
        addDiscovery:              useStore.getState().addDiscovery,
        addLogEntry:               useStore.getState().addLogEntry,
        setJob:                    useStore.getState().setJob,
        addBid:                    useStore.getState().addBid,
        setWinners:                useStore.getState().setWinners,
        setAgent:                  useStore.getState().setAgent,
        incrementStat:             useStore.getState().incrementStat,
        get agents()               { return useStore.getState().agents; },
        // Day 2 — SubAuction
        addSubJob:                 useStore.getState().addSubJob,
        addSubBid:                 useStore.getState().addSubBid,
        updateSubJobStatus:        useStore.getState().updateSubJobStatus,
        get subJobs()              { return useStore.getState().subJobs; },
        // Day 2 — DataMarketplace
        addDataListing:            useStore.getState().addDataListing,
        addDataPurchase:           useStore.getState().addDataPurchase,
        updateDataPurchaseRating:  useStore.getState().updateDataPurchaseRating,
        // Day 2 — PaymentSettlement
        addSettlement:             useStore.getState().addSettlement,
        // Day 2 — GUARD flows
        addGuardFlow:              useStore.getState().addGuardFlow,
        // Day 3 — StakingManager
        updateAgentStake:          useStore.getState().updateAgentStake,
        addSlashEvent:             useStore.getState().addSlashEvent,
        // Day 3 — Treasury
        addTreasuryRevenue:        useStore.getState().addTreasuryRevenue,
        addTreasuryDistribution:   useStore.getState().addTreasuryDistribution,
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
