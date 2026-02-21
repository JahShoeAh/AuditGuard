import { useState, useEffect } from 'react';
import useWalletStore from '../store/wallet';

// Use VITE_API_BASE_URL so Vercel-deployed builds reach the AWS API server.
// Leave unset (or empty) for local dev — the Vite proxy routes /api automatically.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

/**
 * Fetches all audit reports for the connected wallet's deployer address.
 * Queries /api/reports?deployer={address}
 *
 * @returns {{ reports: import('../../../packages/sdk/db/report-types.js').StoredAuditReport[], loading: boolean, error: string|null }}
 */
export function useUserReports() {
  const address         = useWalletStore((s) => s.address);
  const hederaAccountId = useWalletStore((s) => s.hederaAccountId);
  const isConnected     = useWalletStore((s) => s.connectionStatus === 'connected');

  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    const deployer = address || hederaAccountId;
    if (!isConnected || !deployer) {
      setReports([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/api/reports?deployer=${encodeURIComponent(deployer)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (!d.success) throw new Error(d.error || 'Failed to fetch reports');
        setReports(d.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [address, hederaAccountId, isConnected]);

  return { reports, loading, error };
}

/**
 * Lazily fetches a single report by job ID (includes mdContent from S3).
 * Pass null/undefined to skip fetching.
 *
 * @param {string|null|undefined} jobId
 * @returns {{ report: (import('../../../packages/sdk/db/report-types.js').StoredAuditReport & { mdContent: string })|null, loading: boolean, error: string|null }}
 */
export function useReportByJob(jobId) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!jobId) {
      setReport(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/api/reports/${jobId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setReport(d.success ? d.data : null);
        if (!d.success) setError(d.error || 'Report not found');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [jobId]);

  return { report, loading, error };
}
