import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Dashboard from './Dashboard';
import WelcomeScreen from './pages/WelcomeScreen';
import StakeDelegation from './pages/StakeDelegation';
import AgentRegistration from './pages/AgentRegistration';
import ReportMarketplace from './pages/ReportMarketplace';
import WalletConnectModal from './components/wallet/WalletConnectModal';
import { useConnection } from './hooks/useConnection';
import { useEventListeners } from './hooks/useEventListeners';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 10_000, // Poll contract view functions every 10s
      staleTime: 5_000,
    },
  },
});

function Bootstrap() {
  const connection = useConnection();
  useEventListeners(connection);

  return (
    <>
      <Routes>
        <Route path="/" element={<WelcomeScreen />} />
        <Route path="/dashboard">
          <Route index element={<Dashboard />} />
          <Route path="stake" element={<StakeDelegation />} />
          <Route path="agents/register" element={<AgentRegistration />} />
          <Route path="reports" element={<ReportMarketplace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <WalletConnectModal />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Bootstrap />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
