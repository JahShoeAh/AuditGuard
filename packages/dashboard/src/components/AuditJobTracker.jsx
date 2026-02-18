import { useAuditJobs } from '../hooks/useAuditJobs';
import AuditJobCard from './AuditJobCard';

export default function AuditJobTracker() {
  const { jobs } = useAuditJobs();

  return (
    <div className="border-t border-gray-800 bg-gray-950 flex flex-col min-h-0" style={{ height: '260px' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0 border-b border-gray-800">
        <span className="text-amber-400">📋</span>
        <h3 className="text-xs font-bold text-gray-100 uppercase tracking-widest font-mono">
          Audit Job History
        </h3>
        <span className="ml-auto text-xs text-gray-600 font-mono">
          {jobs.length} job{jobs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Horizontally scrollable job cards */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {jobs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-xs font-mono">
            No jobs yet — waiting for mock auction events...
          </div>
        ) : (
          <div className="flex gap-2 px-3 py-2 h-full items-start">
            {jobs.map((job) => (
              <AuditJobCard key={job.jobId} job={job} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
