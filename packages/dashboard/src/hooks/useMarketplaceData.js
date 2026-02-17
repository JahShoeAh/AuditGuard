import { useMemo } from 'react';
import useStore from '../store';
import { useContractRead } from './useContractRead';

/**
 * Combines event-driven store data with a 15-second reconciliation poll
 * against DataMarketplace.getActiveListings().
 *
 * @param {number|null} categoryFilter  Numeric DataCategory enum value, or null for all
 */
export function useMarketplaceData(categoryFilter = null) {
  const dataListings  = useStore((s) => s.dataListings);
  const dataPurchases = useStore((s) => s.dataPurchases);
  const contracts     = useStore((s) => s.contracts);

  // Reconciliation poll — verify we haven't missed any listed events
  const { data: activeListingIds } = useContractRead(
    contracts?.dataMarketplaceContract,
    'getActiveListings',
    [],
    { refetchInterval: 15_000 }
  );

  const listings = useMemo(() => {
    let all = Object.values(dataListings);

    if (categoryFilter !== null) {
      all = all.filter((l) => l.category === categoryFilter);
    }

    // Newest first (highest blockNumber)
    all.sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
    return all;
  }, [dataListings, categoryFilter]);

  // Count listings in contract that aren't in store yet (missed events)
  const missedCount = useMemo(() => {
    if (!activeListingIds) return 0;
    const storeIds = new Set(Object.keys(dataListings));
    let missed = 0;
    for (const id of activeListingIds) {
      if (!storeIds.has(id.toString())) missed++;
    }
    return missed;
  }, [activeListingIds, dataListings]);

  // Count per category for tab badges
  const categoryCounts = useMemo(() => {
    const all = Object.values(dataListings);
    const counts = { ALL: all.length };
    for (const l of all) {
      const key = l.categoryStr || `CAT_${l.category}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [dataListings]);

  return {
    listings,
    recentPurchases: dataPurchases.slice(0, 20),
    missedCount,
    categoryCounts,
  };
}
