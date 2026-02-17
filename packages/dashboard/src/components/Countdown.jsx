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

    const target = typeof deadline === 'bigint' ? Number(deadline) : Number(deadline);

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
    return <span className="text-xs font-mono text-guard-red font-semibold">EXPIRED</span>;
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const display = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  // Color transitions
  let colorClass = 'text-gray-300';
  let extraClass = '';
  if (remaining <= 10) {
    colorClass = 'text-guard-red';
    extraClass = 'animate-pulse-glow';
  } else if (remaining <= 60) {
    colorClass = 'text-guard-amber';
  }

  return (
    <span className={`text-xs font-mono font-semibold ${colorClass} ${extraClass}`}>
      {display}
    </span>
  );
}
