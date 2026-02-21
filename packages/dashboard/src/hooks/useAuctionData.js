import { useMemo, useState, useEffect } from 'react';
import { useContractRead } from './useContractRead';
import useStore from '../store';
import { normalizeAuctionType } from '../utils/auction-type';

function normalizeDeadlineSeconds(value) {
  if (value == null) return null;
  const raw = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Some payloads arrive in milliseconds; normalize to seconds.
  return raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function normalizeTimestampMs(value) {
  if (value == null) return null;
  const raw = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Accept both seconds and milliseconds.
  return raw > 1_000_000_000_000 ? Math.floor(raw) : Math.floor(raw * 1000);
}

export function buildAuctionRows({
  activeJobs,
  bids,
  winners,
  activeJobIds,
  useMockEvents,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  const activeIds = new Set(
    Array.isArray(activeJobIds) ? activeJobIds.map((id) => String(id)) : []
  );
  const strictLive = !useMockEvents;
  const ACTIVE_POLL_LAG_GRACE_MS = 20_000;
  const winnerPendingGraceRaw = Number(import.meta.env.VITE_WINNER_PENDING_GRACE_MS || 20_000);
  const WINNER_PENDING_GRACE_MS = Number.isFinite(winnerPendingGraceRaw)
    ? Math.max(0, winnerPendingGraceRaw)
    : 20_000;
  const winnerSelectedTtlRaw = Number(import.meta.env.VITE_WINNER_SELECTED_TTL_MS || 20_000);
  const WINNER_SELECTED_TTL_MS = Number.isFinite(winnerSelectedTtlRaw)
    ? Math.max(0, winnerSelectedTtlRaw)
    : 20_000;
  const CLOSED_WITH_BIDS_GRACE_MS = Math.max(WINNER_PENDING_GRACE_MS, 120_000);
  const nowMs = nowSec * 1000;

  // Start from store's activeJobs (populated by events or mock)
  const storeJobs = Object.values(activeJobs || {});

  // If we have on-chain job IDs, ensure we're not missing any.
  // In strict-live mode, suppress placeholder skeletons to avoid
  // rendering stale unknown rows for historical active IDs that never hydrated.
  if (Array.isArray(activeJobIds) && !strictLive) {
    const storeIds = new Set(storeJobs.map((j) => String(j.jobId)));
    for (const id of activeJobIds) {
      const idStr = id.toString();
      if (!storeIds.has(idStr)) {
        // Keep a skeleton row if chain is ahead of event ingestion.
        storeJobs.push({
          jobId: idStr,
          contractAddress: null,
          contractType: 'unknown',
          initialRiskScore: 0,
          lineCount: 0,
          budgetFormatted: '? GUARD',
          auctionDeadline: null,
        });
      }
    }
  }

  // Completed jobs stay visible this long so winners have time to render.
  const WINNER_GRACE_MS = 8_000;

  const includeJob = (job) => {
    const jobId = String(job.jobId);
    const winnerData = winners?.[jobId] || null;
    const deadlineSec = normalizeDeadlineSeconds(job.auctionDeadline);
    const hasTerminalStatus = Boolean(job?.terminalStatus);
    const activeSetKnown = activeIds.size > 0;
    const postedAtMs = normalizeTimestampMs(job?.postedAt) ?? normalizeTimestampMs(job?.updatedAt);
    const recentlyObserved = postedAtMs != null ? (nowMs - postedAtMs) <= ACTIVE_POLL_LAG_GRACE_MS : false;
    const hasObservedBids = Array.isArray(bids?.[jobId]) && bids[jobId].length > 0;

    if (!strictLive) {
      // In mock mode, keep previous permissive behavior.
      if (activeIds.size > 0 && activeIds.has(jobId)) return true;
      if (winnerData) return true;
      if (!deadlineSec) return true;
      return nowSec - deadlineSec <= 300;
    }

    if (winnerData) {
      // Winners should remain visible briefly after selection, then disappear.
      const winnerTsMs = normalizeTimestampMs(winnerData.winnersAt)
        ?? normalizeTimestampMs(job.endedAt);
      // Guard gate: if winner timestamp is unavailable, fail closed to avoid indefinite cards.
      if (winnerTsMs == null) return false;
      return (nowMs - winnerTsMs) <= WINNER_SELECTED_TTL_MS;
    }

    // Strict live mode: live feed only shows currently active, non-expired auctions.
    if (hasTerminalStatus) {
      // Keep completed jobs visible briefly so winners state is shown before the card disappears.
      if (job.terminalStatus === 'completed') {
        const endedAtMs = normalizeTimestampMs(job.endedAt);
        return endedAtMs != null && (nowMs - endedAtMs) < WINNER_GRACE_MS;
      }
      return false;
    }
    if (deadlineSec != null) {
      if (deadlineSec <= nowSec) {
        // Keep expired rows visible while contract still reports the job as active.
        // This avoids CLOSED->hidden->WINNER_SELECTED flicker when winner hydration lags.
        if (activeIds.has(jobId)) return true;
        const deadlineMs = deadlineSec * 1000;
        const elapsedMs = nowMs - deadlineMs;
        // Guard gate: if bids were observed, allow a longer hydration window for winner propagation.
        if (hasObservedBids && elapsedMs <= CLOSED_WITH_BIDS_GRACE_MS) return true;
        // Guard gate: keep just-expired auctions visible briefly so winner hydration
        // from event pipelines cannot race with card removal.
        return elapsedMs <= WINNER_PENDING_GRACE_MS;
      }
      // Future-deadline, non-terminal auctions should remain visible even when
      // active-id polling is temporarily stale.
      return true;
    }
    if (activeIds.has(jobId)) return true;
    // Missing deadline fallback: keep freshly observed rows briefly while
    // on-chain active-id polling catches up.
    if (!activeSetKnown || recentlyObserved) return true;
    return false;
  };

  const getDeadline = (job) => normalizeDeadlineSeconds(job.auctionDeadline) ?? Number.MAX_SAFE_INTEGER;

  return storeJobs
    .filter(includeJob)
    .map((job) => ({
      job: {
        ...job,
        contractType: normalizeAuctionType(job.contractType),
      },
      bids: bids?.[job.jobId] || [],
      winnerData: winners?.[job.jobId] || null,
    }))
    .sort((a, b) => {
      const byDeadline = getDeadline(a.job) - getDeadline(b.job);
      if (byDeadline !== 0) return byDeadline;
      return Number(b.job.jobId) - Number(a.job.jobId);
    });
}

/**
 * Combines event-driven store data with polled contract reads.
 *
 * In mock mode (or when contracts are unavailable) this just returns
 * the store data directly. When live contracts are available, it also
 * polls getActiveJobs() and enriches each auction with on-chain data.
 */
export function useAuctionData() {
  const activeJobs = useStore((s) => s.activeJobs);
  const bids = useStore((s) => s.bids);
  const winners = useStore((s) => s.winners);
  const contracts = useStore((s) => s.contracts);
  const useMockEvents = useStore((s) => s.useMockEvents);

  const auctionContract = contracts?.auctionContract || null;

  const activeJobsPollMs = Number(import.meta.env.VITE_ACTIVE_JOBS_POLL_MS || 3_000);

  // Poll for active job IDs from the contract (live mode only)
  const { data: activeJobIds } = useContractRead(
    useMockEvents ? null : auctionContract,
    'getActiveJobs',
    [],
    {
      refetchInterval: activeJobsPollMs,
      structuralSharing: false,
    },
  );

  const normalizedActiveJobIds = Array.isArray(activeJobIds)
    ? activeJobIds.map((id) => String(id))
    : [];

  // Drive re-renders for time-sensitive strict-live windows so deadline/grace transitions
  // are deterministic even when no new events arrive.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (useMockEvents) return;
    if (Object.keys(activeJobs || {}).length === 0) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 2_000);
    return () => clearInterval(id);
  }, [activeJobs, useMockEvents]);

  // Merge store data into enriched auction objects
  const auctions = useMemo(() => {
    return buildAuctionRows({
      activeJobs,
      bids,
      winners,
      activeJobIds: normalizedActiveJobIds,
      useMockEvents,
      nowSec,
    });
  }, [activeJobs, bids, winners, normalizedActiveJobIds, useMockEvents, nowSec]);

  return {
    auctions,
    isLoading: false,
  };
}
