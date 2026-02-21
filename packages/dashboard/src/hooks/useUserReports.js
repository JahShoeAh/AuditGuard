import { useEffect, useState } from 'react';
import useWalletStore from '../store/wallet';

const REPORTS_API_BASE = (
  import.meta.env.VITE_REPORTS_API_BASE_URL
  ?? import.meta.env.VITE_API_BASE_URL
  ?? ''
).trim().replace(/\/$/, '');

export function useUserReports() {
  const { address, isConnected } = useWalletStore((s) => ({
    address: s.address,
    isConnected: s.connectionStatus === 'connected',
  }));

  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    if (!isConnected || !address || !REPORTS_API_BASE) {
      setReports([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const loadReports = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `${REPORTS_API_BASE}/api/reports?deployer=${encodeURIComponent(address)}`
        );
        if (response.status === 404) {
          if (cancelled) return;
          setReports([]);
          setError(null);
          return;
        }
        if (!response.ok) {
          throw new Error(`Reports API responded ${response.status}`);
        }
        const data = await response.json();
        if (cancelled) return;

        if (data?.success) {
          setReports(Array.isArray(data.data) ? data.data : []);
          setError(null);
        } else {
          setReports([]);
          setError(typeof data?.error === 'string' ? data.error : 'Failed to load reports');
        }
      } catch (err) {
        if (cancelled) return;
        setReports([]);
        setError(err instanceof Error ? err.message : 'Failed to load reports');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadReports();

    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);

  return { reports, loading, error };
}

export function useReportByJob(jobId) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    if (!jobId || !REPORTS_API_BASE) {
      setReport(null);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const loadReport = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `${REPORTS_API_BASE}/api/reports/${encodeURIComponent(jobId)}`
        );
        if (response.status === 404) {
          if (cancelled) return;
          setReport(null);
          setError(null);
          return;
        }
        if (!response.ok) {
          throw new Error(`Reports API responded ${response.status}`);
        }
        const data = await response.json();
        if (cancelled) return;

        if (data?.success) {
          setReport(data.data ?? null);
          setError(null);
        } else {
          setReport(null);
          setError(typeof data?.error === 'string' ? data.error : 'Failed to load report');
        }
      } catch (err) {
        if (cancelled) return;
        setReport(null);
        setError(err instanceof Error ? err.message : 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadReport();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return { report, loading, error };
}
