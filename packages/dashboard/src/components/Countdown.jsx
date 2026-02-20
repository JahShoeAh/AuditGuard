import { useState, useEffect } from 'react';

/**
 * Countdown timer that ticks every second.
 * @param {{ deadline: number|bigint|null }} props
 *   deadline — Unix timestamp in seconds (not ms)
 */
export default function Countdown({ deadline }) {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    if (!deadline) return;

    const rawTarget = typeof deadline === 'bigint' ? Number(deadline) : Number(deadline);
    const target = rawTarget > 1_000_000_000_000
      ? Math.floor(rawTarget / 1000)
      : Math.floor(rawTarget);

    function tick() {
      const now = Math.floor(Date.now() / 1000);
      setRemaining(Math.max(0, target - now));
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline == null) {
    return <span className="text-xs font-mono text-gray-600">&mdash;</span>;
  }

  if (remaining === null) {
    return <span className="text-xs font-mono text-gray-600">...</span>;
  }

  if (remaining <= 0) {
    return <span className="text-xs font-mono text-guard-red font-semibold">CLOSED</span>;
  }

  const hours = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;
  const display = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  // Color transitions
  let colorClass = 'text-gray-300';
  let extraClass = '';
  if (remaining <= 10) {
    colorClass = 'text-guard-red';
    extraClass = 'animate-pulse-glow';
  } else if (remaining <= 30) {
    colorClass = 'text-guard-amber';
  }

  return (
    <span className={`text-xs font-mono font-semibold ${colorClass} ${extraClass}`}>
      {display}
    </span>
  );
}
