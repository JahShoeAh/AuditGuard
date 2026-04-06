import { useState } from "react";
import useWalletStore from "../../store/wallet";
import { useUserReports, useReportByJob } from "../../hooks/useUserReports";
import { fmt } from "../../utils/format";

const SEV_CLASSES = {
  critical: "bg-red-900/30 text-red-400 border border-red-500/30",
  high: "bg-orange-900/30 text-orange-400 border border-orange-500/30",
  medium: "bg-amber-900/30 text-amber-300 border border-amber-500/30",
  low: "bg-blue-900/30 text-blue-400 border border-blue-500/30",
  info: "bg-gray-800 text-gray-400 border border-gray-700",
};

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findingsCount(report) {
  const fromRecord = toFiniteNumber(report?.findingCount, NaN);
  if (Number.isFinite(fromRecord)) return fromRecord;

  const map = report?.findingsBySeverity ?? {};
  return (
    toFiniteNumber(map.critical)
    + toFiniteNumber(map.high)
    + toFiniteNumber(map.medium)
    + toFiniteNumber(map.low)
    + toFiniteNumber(map.info)
  );
}

function agentCount(report) {
  const fromRecord = toFiniteNumber(report?.agentCount, NaN);
  if (Number.isFinite(fromRecord)) return fromRecord;
  return Array.isArray(report?.agentAddresses) ? report.agentAddresses.length : 0;
}

function ReportCard({ report }) {
  const [expanded, setExpanded] = useState(false);
  const { report: full, loading: fullLoading, error: fullError } = useReportByJob(
    expanded ? report.jobId : null
  );

  const severityMap = report.findingsBySeverity ?? {};
  const date = report.timestamp ? new Date(Number(report.timestamp)).toLocaleDateString() : "—";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-cyan-500/40 transition-all">
      <div className="flex items-start justify-between p-4 border-b border-gray-800 bg-gradient-to-r from-gray-900 to-gray-950">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold font-mono text-gray-200">
              Job #{report.jobId}
            </span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
              (report.chain ?? "").includes("hedera")
                ? "bg-blue-500/20 text-blue-400"
                : "bg-purple-500/20 text-purple-400"
            }`}>
              {(report.chain ?? "UNKNOWN").toUpperCase()}
            </span>
          </div>
          <p className="text-[10px] font-mono text-gray-500 mt-0.5">
            Contract:{" "}
            <span className="text-cyan-400">{fmt.address(report.contractAddress)}</span>
          </p>
        </div>
        <span className="text-[10px] text-gray-600 font-mono">{date}</span>
      </div>

      <div className="p-4 space-y-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">
            Findings by severity
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(severityMap).map(([severity, count]) => (
              Number(count) > 0 ? (
                <span
                  key={severity}
                  className={`text-[9px] font-bold px-2 py-0.5 rounded ${SEV_CLASSES[severity] ?? SEV_CLASSES.info}`}
                >
                  {severity.toUpperCase()}: {count}
                </span>
              ) : null
            ))}
            {Object.values(severityMap).every((count) => Number(count) === 0) && (
              <span className="text-[10px] text-gray-600 font-mono">No findings</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between text-[10px] font-mono text-gray-500 border-t border-gray-800 pt-2">
          <span>
            Total findings:{" "}
            <span className="text-gray-300 font-bold">{findingsCount(report)}</span>
          </span>
          <span>
            Agents:{" "}
            <span className="text-gray-300 font-bold">{agentCount(report)}</span>
          </span>
        </div>

        {Array.isArray(report.tags) && report.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {report.tags.map((tag, index) => (
              <span
                key={`${String(tag)}:${index}`}
                className="text-[9px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded font-mono"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="w-full text-center text-[10px] font-mono text-cyan-500 hover:text-cyan-300 transition-colors py-1 border border-gray-800 rounded"
        >
          {expanded ? "Hide Preview ↑" : "Show Preview ↓"}
        </button>

        {expanded && (
          <div className="bg-gray-950 rounded border border-gray-800 p-3 max-h-64 overflow-y-auto text-[11px] font-mono text-gray-300">
            {fullLoading && (
              <div className="flex items-center gap-2 text-gray-500">
                <div className="animate-spin h-3 w-3 border border-gray-500 border-t-cyan-400 rounded-full" />
                Loading report...
              </div>
            )}
            {fullError && !fullLoading && (
              <p className="text-red-400">{fullError}</p>
            )}
            {!fullLoading && !fullError && full?.mdContent && (
              <pre className="whitespace-pre-wrap break-words">
                {full.mdContent.length > 1000
                  ? `${full.mdContent.slice(0, 1000)}...`
                  : full.mdContent}
              </pre>
            )}
            {!fullLoading && !fullError && !full?.mdContent && (
              <p className="text-gray-600 italic">Report content unavailable.</p>
            )}
          </div>
        )}
      </div>

      {report.cid && (
        <div className="px-4 py-2 bg-gray-950 border-t border-gray-800 text-[9px] font-mono text-gray-600 truncate">
          CID: {report.cid}
        </div>
      )}
    </div>
  );
}

export default function UserReportList() {
  const address = useWalletStore((s) => s.address);
  const hederaAccountId = useWalletStore((s) => s.hederaAccountId);
  const isConnected = useWalletStore((s) => s.connectionStatus === "connected");
  const openModal = useWalletStore((s) => s.openWalletModal);
  const { reports, loading, error } = useUserReports();

  const displayAddr = address || hederaAccountId;

  if (!isConnected) {
    return (
      <div className="text-center py-10">
        <p className="text-sm font-mono text-gray-400 mb-4">
          Connect your wallet to view audit reports for contracts you deployed.
        </p>
        <button
          type="button"
          onClick={() => openModal("reports")}
          className="bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-mono font-bold py-2 px-5 rounded-lg transition-colors"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 gap-2 text-gray-500 text-xs font-mono">
        <div className="animate-spin h-4 w-4 border border-gray-600 border-t-cyan-400 rounded-full" />
        Fetching your reports...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
        <p className="text-red-400 font-mono text-sm font-bold">Failed to load reports</p>
        <p className="text-red-300 font-mono text-xs mt-1">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 text-xs font-mono text-cyan-400 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm font-mono text-gray-400">
          No audit reports found for{" "}
          <span className="text-cyan-400 font-bold">{fmt.address(displayAddr)}</span>.
        </p>
        <p className="text-xs font-mono text-gray-600 mt-2 max-w-xs mx-auto">
          Reports appear here once an audit job for your deployed contract completes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] font-mono text-gray-500">
        {reports.length} audit report{reports.length !== 1 ? "s" : ""} for{" "}
        <span className="text-cyan-400">{fmt.address(displayAddr)}</span>
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {reports.map((report) => (
          <ReportCard key={report.id ?? report.jobId} report={report} />
        ))}
      </div>
    </div>
  );
}
