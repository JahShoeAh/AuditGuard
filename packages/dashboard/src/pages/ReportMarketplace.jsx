import { useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import useRequireWallet from '../hooks/useRequireWallet';

export default function ReportMarketplace() {
  const { address, requireWallet } = useRequireWallet();
  const [status, setStatus] = useState('');

  const handleMockPurchase = () => {
    if (!requireWallet('purchase reports')) return;
    setStatus('Wallet unlocked. Report purchase flow will be wired in Prompt 5.');
  };

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <Link to="/dashboard" className="text-sm text-cyan-300 hover:text-cyan-200">{'<-'} Back to dashboard</Link>
        <h1 className="mt-4 font-mono text-2xl font-semibold uppercase tracking-wider">Report Marketplace</h1>
        <p className="mt-2 text-sm text-gray-400">
          Connected account: {address || 'none'}
        </p>
        <button
          type="button"
          onClick={handleMockPurchase}
          className="mt-6 rounded border border-cyan-500/50 bg-cyan-500/10 px-4 py-2 text-sm font-mono uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/20"
        >
          Purchase Report
        </button>
        {status && <p className="mt-3 text-sm text-amber-300">{status}</p>}
      </main>
    </div>
  );
}
