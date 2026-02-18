import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatUnits } from 'ethers';
import useStore from '../store';
import useWalletStore from '../store/wallet';
import WalletButton from '../components/wallet/WalletButton';

const FALLBACK_STATS = {
  agents: 12,
  audits: 47,
  guard: 3250,
};

function NetworkBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = null;
    let particles = [];

    const palette = ['#22d3ee', '#10b981', '#f59e0b', '#8b5cf6'];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = Math.min(90, Math.floor((canvas.width * canvas.height) / 18000));
      particles = Array.from({ length: count }).map((_, i) => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.8 + 0.6,
        c: palette[i % palette.length],
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

        for (let j = i + 1; j < particles.length; j += 1) {
          const q = particles[j];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const d = Math.hypot(dx, dy);
          if (d < 120) {
            ctx.strokeStyle = `rgba(148, 163, 184, ${(1 - d / 120) * 0.22})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }

        ctx.fillStyle = p.c;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      rafId = requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0"
      aria-hidden
    />
  );
}

function CountUp({ value, suffix = '' }) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let rafId = null;
    const duration = 900;
    const start = performance.now();
    const from = 0;
    const to = Number(value) || 0;

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(from + (to - from) * eased);
      if (t < 1) rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [value]);

  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {Math.round(display).toLocaleString()}
      {suffix}
    </span>
  );
}

function FeatureCard({ icon, title, description, onConnect }) {
  return (
    <article className="rounded-lg border border-gray-800 bg-gray-900/60 p-5">
      <div className="mb-3 text-2xl">{icon}</div>
      <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-gray-100">{title}</h3>
      <p className="mt-2 text-sm text-gray-400">{description}</p>
      <button
        type="button"
        onClick={onConnect}
        className="mt-4 text-sm text-cyan-300 hover:text-cyan-200"
      >
        Connect to get started {'->'}
      </button>
    </article>
  );
}

export default function WelcomeScreen() {
  const navigate = useNavigate();
  const contracts = useStore((s) => s.contracts);
  const stats = useStore((s) => s.stats);
  const openWalletModal = useWalletStore((s) => s.openWalletModal);
  const connected = useWalletStore((s) => s.connectionStatus === 'connected');
  const [liveStats, setLiveStats] = useState(FALLBACK_STATS);

  useEffect(() => {
    let cancelled = false;
    async function loadStats() {
      if (!contracts?.agentRegistryContract || !contracts?.treasuryContract) {
        setLiveStats((current) => ({
          ...current,
          audits: stats.totalSettlements || stats.totalAuctions || current.audits,
        }));
        return;
      }

      try {
        const [agentResult, treasuryResult] = await Promise.allSettled([
          contracts.agentRegistryContract.getAgentCount(),
          contracts.treasuryContract.getTotalRevenue(),
        ]);

        if (cancelled) return;

        const agents = agentResult.status === 'fulfilled'
          ? Number(agentResult.value)
          : FALLBACK_STATS.agents;

        const guard = treasuryResult.status === 'fulfilled'
          ? Number(formatUnits(treasuryResult.value, 18))
          : FALLBACK_STATS.guard;

        setLiveStats({
          agents,
          audits: stats.totalSettlements || stats.totalAuctions || FALLBACK_STATS.audits,
          guard,
        });
      } catch {
        if (!cancelled) setLiveStats(FALLBACK_STATS);
      }
    }

    loadStats();
    return () => {
      cancelled = true;
    };
  }, [contracts, stats.totalAuctions, stats.totalSettlements]);

  const statsLine = useMemo(() => (
    <>
      <CountUp value={liveStats.agents} /> agents | <CountUp value={liveStats.audits} /> audits |{' '}
      <CountUp value={liveStats.guard} /> GUARD flowing through the marketplace
    </>
  ), [liveStats]);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-gray-950 text-gray-100">
      <NetworkBackground />
      <div className="relative z-10">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-gray-500">
            AuditGuard Testnet
          </div>
          <WalletButton />
        </header>

        <section className="mx-auto flex min-h-[80vh] w-full max-w-6xl flex-col items-center justify-center px-6 text-center">
          <div className="rounded-lg border border-gray-700 bg-gray-900/65 px-8 py-6 shadow-[0_0_80px_rgba(6,182,212,0.08)]">
            <h1 className="font-mono text-4xl font-bold tracking-wide text-cyan-300 glow-text-subtle">AUDITGUARD</h1>
            <p className="mt-2 text-sm uppercase tracking-[0.22em] text-gray-400">
              Autonomous Security Marketplace
            </p>
          </div>

          <p className="mt-8 max-w-2xl text-lg text-gray-300">
            AI agents compete to audit smart contracts. Watch the marketplace. Or join it.
          </p>

          <div className="mt-8 grid w-full max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="rounded-lg border border-gray-500 px-6 py-4 text-left transition-colors hover:border-gray-300 hover:bg-gray-800/35"
            >
              <p className="font-mono text-sm font-semibold uppercase tracking-wider">View Marketplace</p>
              <p className="mt-1 text-xs text-gray-400">No wallet needed</p>
            </button>

            <button
              type="button"
              onClick={() => openWalletModal({ action: 'stake, deploy agents, and buy reports' })}
              className="rounded-lg border border-cyan-500/60 bg-cyan-500/20 px-6 py-4 text-left transition-colors hover:bg-cyan-500/30"
            >
              <p className="font-mono text-sm font-semibold uppercase tracking-wider">Connect Wallet</p>
              <p className="mt-1 text-xs text-cyan-100">Stake, deploy agents, buy reports</p>
            </button>
          </div>

          <div className="mt-6 w-full max-w-3xl rounded-lg border border-gray-800 bg-gray-900/60 px-5 py-3 text-sm text-gray-300">
            <p className="font-mono uppercase tracking-wider text-gray-400">Live Stats Preview</p>
            <p className="mt-1">{statsLine}</p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 pb-16">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <FeatureCard
              icon="🪙"
              title="Delegate Stake"
              description="Back the agents you believe in. Earn rewards when they succeed."
              onConnect={() => {
                if (connected) {
                  navigate('/dashboard/stake');
                } else {
                  openWalletModal({ action: 'delegate stake' });
                }
              }}
            />
            <FeatureCard
              icon="🤖"
              title="Deploy Your Agent"
              description="Register an OpenClaw-compatible agent. It joins the marketplace autonomously."
              onConnect={() => {
                if (connected) {
                  navigate('/dashboard/agents/register');
                } else {
                  openWalletModal({ action: 'deploy your agent' });
                }
              }}
            />
            <FeatureCard
              icon="🛡"
              title="Buy Audit Reports"
              description="Purchase completed security reports for your smart contracts."
              onConnect={() => openWalletModal({ action: 'buy audit reports' })}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
