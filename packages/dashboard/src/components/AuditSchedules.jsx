import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store';
import { hashscan } from '../utils/hashscan';
import { formatDistanceToNow, formatDistanceToNowStrict } from 'date-fns';

// ── Helpers ───────────────────────────────────────────────────────────────────

function short(addr) {
	if (!addr || addr === '0x0000000000000000000000000000000000000000') return '—';
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function countdown(unixSec) {
	if (!unixSec || unixSec === 0) return null;
	const ms = Number(unixSec) * 1000;
	if (ms < Date.now()) return 'overdue';
	return formatDistanceToNowStrict(ms, { addSuffix: true });
}

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ active, reason }) {
	if (!active) {
		return (
			<span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded border"
				style={{ color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)' }}>
				✕ CANCELLED
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded border"
			style={{ color: 'var(--accent-green)', borderColor: 'rgba(52,211,153,0.3)', background: 'rgba(52,211,153,0.08)' }}>
			● ACTIVE
		</span>
	);
}

// ── Mode badge ────────────────────────────────────────────────────────────────

function ModeBadge({ mode }) {
	const isTimeBased = mode === 'TIME_BASED' || mode === 0;
	return (
		<span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border"
			style={{
				color: isTimeBased ? 'var(--accent-cyan)' : 'var(--accent-amber)',
				borderColor: isTimeBased ? 'rgba(34,211,238,0.25)' : 'rgba(251,191,36,0.25)',
				background: isTimeBased ? 'rgba(34,211,238,0.06)' : 'rgba(251,191,36,0.06)',
			}}>
			{isTimeBased ? '⏱' : '🔄'} {isTimeBased ? 'Time-Based' : 'Redeploy'}
		</span>
	);
}

// ── Single schedule row ───────────────────────────────────────────────────────

function ScheduleRow({ entry }) {
	const { contractAddress, scheduleAddress, active, mode, nextAuditDue, timesTriggered, intervalSeconds, cancelReason } = entry;

	const due = countdown(nextAuditDue);
	const interval = intervalSeconds > 0
		? `${Math.round(Number(intervalSeconds) / 86400)}d`
		: null;

	return (
		<motion.div
			layout
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.25 }}
			className="border border-gray-800 rounded-lg p-3 flex flex-col gap-2 hover:border-gray-700 transition-colors"
			style={{ background: 'rgba(17,24,39,0.6)' }}
		>
			{/* Top row: address + mode + status */}
			<div className="flex items-center gap-2 flex-wrap">
				<a
					href={hashscan(contractAddress)}
					target="_blank"
					rel="noopener noreferrer"
					className="font-mono text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
				>
					{short(contractAddress)}
				</a>
				<ModeBadge mode={mode} />
				<StatusChip active={active} />
				{interval && (
					<span className="text-[10px] font-mono text-gray-500">every {interval}</span>
				)}
			</div>

			{/* Schedule details */}
			<div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[10px] font-mono">
				<div>
					<span className="text-gray-600 uppercase tracking-wider">Schedule</span>
					<div>
						{scheduleAddress && scheduleAddress !== '0x0000000000000000000000000000000000000000' ? (
							<a
								href={hashscan(scheduleAddress)}
								target="_blank"
								rel="noopener noreferrer"
								className="text-purple-400 hover:text-purple-300 transition-colors"
							>
								{short(scheduleAddress)}
							</a>
						) : <span className="text-gray-600">—</span>}
					</div>
				</div>
				<div>
					<span className="text-gray-600 uppercase tracking-wider">Next Audit</span>
					<div className={due === 'overdue' ? 'text-red-400' : 'text-gray-300'}>
						{due ?? '—'}
					</div>
				</div>
				<div>
					<span className="text-gray-600 uppercase tracking-wider">Times triggered</span>
					<div className="text-white">{String(timesTriggered ?? 0)}</div>
				</div>
			</div>

			{/* Cancellation reason */}
			{!active && cancelReason && (
				<div className="text-[10px] font-mono text-red-400/70">
					Reason: {cancelReason}
				</div>
			)}
		</motion.div>
	);
}

// ── Empty-state ───────────────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="flex flex-col items-center justify-center h-full gap-3 py-12">
			<span className="text-4xl opacity-30">⏱</span>
			<p className="text-xs font-mono text-gray-500 text-center max-w-xs">
				No scheduled audits yet. Vault owners can call{' '}
				<span className="text-cyan-500">AuditScheduler.scheduleAudit()</span> to set a recurring cadence.
			</p>
		</div>
	);
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AuditSchedules() {
	// Pull HSS events from the Zustand store (populated by event-listener)
	const hssEvents = useStore((s) => s.hssEvents ?? []);

	// Build a map of contractAddress → latest schedule state from events
	const schedules = useMemo(() => {
		const map = new Map();

		for (const ev of hssEvents) {
			const addr = ev.contractAddress;
			if (!addr) continue;

			if (ev.type === 'AuditScheduled' || ev.type === 'HSS_AUDIT_SCHEDULED') {
				const prev = map.get(addr) ?? {};
				map.set(addr, {
					...prev,
					contractAddress: addr,
					scheduleAddress: ev.scheduleAddress ?? prev.scheduleAddress,
					mode: ev.mode ?? prev.mode ?? 'TIME_BASED',
					intervalSeconds: ev.intervalSeconds ?? prev.intervalSeconds ?? 0,
					nextAuditDue: ev.nextAuditDue ?? prev.nextAuditDue,
					timesTriggered: prev.timesTriggered ?? 0,
					active: true,
				});
			}

			if (ev.type === 'AuditTriggered' || ev.type === 'HSS_AUDIT_TRIGGERED') {
				const prev = map.get(addr) ?? {};
				map.set(addr, {
					...prev,
					contractAddress: addr,
					scheduleAddress: ev.nextScheduleAddress ?? ev.scheduleAddress ?? prev.scheduleAddress,
					timesTriggered: (prev.timesTriggered ?? 0) + 1,
					nextAuditDue: ev.nextAuditDue ?? prev.nextAuditDue,
					active: true,
				});
			}

			if (ev.type === 'AuditScheduleCancelled' || ev.type === 'HSS_SCHEDULE_CANCELLED') {
				const prev = map.get(addr) ?? {};
				map.set(addr, {
					...prev,
					contractAddress: addr,
					active: false,
					cancelReason: ev.reason ?? 'cancelled',
				});
			}
		}

		return Array.from(map.values()).sort((a, b) => Number(!!b.active) - Number(!!a.active));
	}, [hssEvents]);

	const activeCount = schedules.filter((s) => s.active).length;

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center gap-3">
				<span className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-500">
					HSS SCHEDULES
				</span>
				{activeCount > 0 && (
					<span className="text-[10px] font-mono px-2 py-0.5 rounded-full font-bold"
						style={{ background: 'rgba(34,211,238,0.12)', color: 'var(--accent-cyan)' }}>
						{activeCount} active
					</span>
				)}
				<span className="ml-auto text-[10px] font-mono text-gray-700">
					Powered by HSS @ 0x16b
				</span>
			</div>

			{/* Schedule list */}
			<div className="flex-1 overflow-y-auto p-4">
				{schedules.length === 0 ? (
					<EmptyState />
				) : (
					<div className="flex flex-col gap-3">
						<AnimatePresence>
							{schedules.map((s) => (
								<ScheduleRow key={s.contractAddress} entry={s} />
							))}
						</AnimatePresence>
					</div>
				)}
			</div>
		</div>
	);
}
