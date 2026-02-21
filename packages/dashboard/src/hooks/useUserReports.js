import { useEffect, useState } from "react";
import useWalletStore from "../store/wallet";

const REPORTS_API_BASE = (
  import.meta.env.VITE_REPORTS_API_BASE_URL
  ?? import.meta.env.VITE_API_BASE_URL
  ?? ""
).trim().replace(/\/$/, "");

function apiUrl(path) {
  return REPORTS_API_BASE ? `${REPORTS_API_BASE}${path}` : path;
}

/**
 * @returns {{ reports: import("../../../packages/sdk/db/report-types.js").StoredAuditReport[], loading: boolean, error: string|null }}
 */
export function useUserReports() {
  const address = useWalletStore((s) => s.address);
  const hederaAccountId = useWalletStore((s) => s.hederaAccountId);
  const isConnected = useWalletStore((s) => s.connectionStatus === "connected");

  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const deployer = address || hederaAccountId;
    let cancelled = false;

    if (!isConnected || !deployer) {
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
          apiUrl(`/api/reports?deployer=${encodeURIComponent(deployer)}`)
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
          setError(typeof data?.error === "string" ? data.error : "Failed to load reports");
        }
      } catch (err) {
        if (cancelled) return;
        setReports([]);
        setError(err instanceof Error ? err.message : "Failed to load reports");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadReports();

    return () => {
      cancelled = true;
    };
  }, [address, hederaAccountId, isConnected]);

  return { reports, loading, error };
}

/**
 * @param {string|null|undefined} jobId
 * @returns {{ report: (import("../../../packages/sdk/db/report-types.js").StoredAuditReport & { mdContent: string })|null, loading: boolean, error: string|null }}
 */
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
          apiUrl(`/api/reports/${encodeURIComponent(jobId)}`)
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
          setError(typeof data?.error === "string" ? data.error : "Failed to load report");
        }
      } catch (err) {
        if (cancelled) return;
        setReport(null);
        setError(err instanceof Error ? err.message : "Failed to load report");
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
