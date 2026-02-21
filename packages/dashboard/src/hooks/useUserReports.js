import { useEffect, useState } from 'react';
import useWalletStore from '../store/wallet';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

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

    if (!isConnected || !address) {
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
          `${API_BASE}/api/reports?deployer=${encodeURIComponent(address)}`
        );
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

    if (!jobId) {
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
          `${API_BASE}/api/reports/${encodeURIComponent(jobId)}`
        );
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
