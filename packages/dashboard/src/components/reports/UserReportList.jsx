import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useUserReports } from '../../hooks/useUserReports';
import useWalletStore from '../../store/wallet';

const SEVERITY_STYLES = {
  critical: 'bg-red-900/30 text-red-400 border-red-500/30',
  high: 'bg-orange-900/30 text-orange-400 border-orange-500/30',
  medium: 'bg-amber-900/30 text-amber-300 border-amber-500/30',
  low: 'bg-blue-900/30 text-blue-400 border-blue-500/30',
};

function shortenAddress(address) {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getGeneratedAt(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return 'Unknown date';
  return new Date(Number(timestamp)).toLocaleString();
}

function severityValue(report, severity) {
  const map = report?.findingsBySeverity ?? {};
  return Number(map?.[severity] ?? 0);
}

function findingsCount(report) {
  const fromRecord = Number(report?.findingCount ?? NaN);
  if (Number.isFinite(fromRecord)) return fromRecord;
  return (
    severityValue(report, 'critical')
    + severityValue(report, 'high')
    + severityValue(report, 'medium')
    + severityValue(report, 'low')
    + Number(report?.findingsBySeverity?.info ?? 0)
  );
}

function agentCount(report) {
  const fromRecord = Number(report?.agentCount ?? NaN);
  if (Number.isFinite(fromRecord)) return fromRecord;
  return Array.isArray(report?.agentAddresses) ? report.agentAddresses.length : 0;
}

function ReportCard({ report }) {
  const tags = Array.isArray(report?.tags) ? report.tags : [];

  return (
    <article className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-cyan-500/40 hover:shadow-[0_0_20px_rgba(34,211,238,0.08)] transition-all">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-gray-500">Job #{report.jobId}</p>
          <h3 className="text-sm font-semibold text-gray-100 mt-1">{shortenAddress(report.contractAddress)}</h3>
        </div>
        <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-cyan-500/30 text-cyan-300 bg-cyan-900/20">
          {report.chain ?? 'unknown-chain'}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {Object.entries(SEVERITY_STYLES).map(([severity, style]) => (
          <span
            key={severity}
            className={`text-[11px] px-2 py-1 rounded-md border font-medium ${style}`}
          >
            {severity}: {severityValue(report, severity)}
          </span>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-gray-300">
        <div className="rounded-lg border border-gray-800 p-2">
          <p className="text-gray-500 text-[10px] uppercase tracking-wide">Findings</p>
          <p className="mt-1 font-semibold">{findingsCount(report)}</p>
        </div>
        <div className="rounded-lg border border-gray-800 p-2">
          <p className="text-gray-500 text-[10px] uppercase tracking-wide">Agents</p>
          <p className="mt-1 font-semibold">{agentCount(report)}</p>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-2 py-1 rounded-full bg-gray-800 border border-gray-700 text-gray-300"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <Link
          to={`/reports/${report.jobId}`}
          className="text-sm font-medium text-cyan-300 hover:text-cyan-200 hover:underline"
        >
          View Full Report
        </Link>
        <p className="text-[11px] text-gray-500">{getGeneratedAt(report.timestamp)}</p>
      </div>
    </article>
  );
}

export default function UserReportList() {
  const { reports, loading, error } = useUserReports();
  const { address, isConnected } = useWalletStore((s) => ({
    address: s.address,
    isConnected: s.connectionStatus === 'connected',
  }));
  const [connectBusy, setConnectBusy] = useState(false);

  const connectWallet = async () => {
    setConnectBusy(true);
    try {
      await useWalletStore.getState().connect('metamask');
    } finally {
      setConnectBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-500/40 bg-red-900/20 rounded-xl p-4 text-red-300">
        <p className="text-sm font-medium">Failed to load reports: {error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 text-xs px-3 py-1.5 rounded-md border border-red-400/40 hover:bg-red-800/40 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!isConnected || !address) {
    return (
      <div className="border border-gray-800 bg-gray-900 rounded-xl p-6 text-center">
        <h3 className="text-lg font-semibold text-gray-100">Connect Your Wallet</h3>
        <p className="text-sm text-gray-400 mt-2">
          Connect your wallet to view audit reports for contracts you deployed.
        </p>
        <button
          type="button"
          onClick={connectWallet}
          disabled={connectBusy}
          className="mt-4 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-white text-sm font-medium transition-colors"
        >
          {connectBusy ? 'Connecting...' : 'Connect Wallet'}
        </button>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="border border-gray-800 bg-gray-900 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-gray-100">No Audit Reports Found</h3>
        <p className="text-sm text-gray-400 mt-2">
          No reports were found for deployer address{' '}
          <span className="text-cyan-300 font-mono">{address}</span>.
        </p>
      </div>
    );
  }

  return (
    <section>
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-gray-100">My Reports ({reports.length})</h3>
        <p className="text-sm text-gray-400 mt-1">
          Reports generated for contracts deployed by your connected wallet.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {reports.map((report) => (
          <ReportCard key={report.id ?? report.jobId} report={report} />
        ))}
      </div>
    </section>
  );
}
