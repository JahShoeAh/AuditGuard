import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Header from '../components/Header';
import WalletButton from '../components/wallet/WalletButton';
import useWalletStore from '../store/wallet';
import { useConnection } from '../hooks/useConnection';
import { useEventListeners } from '../hooks/useEventListeners';
import StepIdentity,       { validateStep1 } from '../components/agent-register/StepIdentity';
import StepUCP,            { validateStep2 } from '../components/agent-register/StepUCP';
import StepSpecialization, { validateStep3 } from '../components/agent-register/StepSpecialization';
import StepDeploy from '../components/agent-register/StepDeploy';

// ── Bootstrap hook ─────────────────────────────────────────
function useBootstrap() {
  const conn = useConnection();
  useEventListeners(conn);
}

// ── Step metadata ──────────────────────────────────────────

const STEPS = [
  { number: 1, label: 'Agent Identity'      },
  { number: 2, label: 'UCP Configuration'   },
  { number: 3, label: 'Specialization'      },
  { number: 4, label: 'Review & Deploy'     },
];

// ── Progress indicator ─────────────────────────────────────

function ProgressBar({ step }) {
  return (
    <div className="flex items-center gap-0 mb-1">
      {STEPS.map((s, i) => {
        const done    = s.number < step;
        const current = s.number === step;
        return (
          <div key={s.number} className="flex items-center flex-1 last:flex-none">
            {/* dot */}
            <div className={[
              'w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
              done    ? 'bg-green-500 border-green-500'  :
              current ? 'bg-cyan-400 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.4)]' :
                        'bg-gray-800 border-gray-600',
            ].join(' ')}>
              {done ? (
                <span className="text-[10px] text-white font-bold">✓</span>
              ) : (
                <span className={`text-[10px] font-bold ${current ? 'text-gray-900' : 'text-gray-600'}`}>
                  {s.number}
                </span>
              )}
            </div>
            {/* connector line */}
            {i < STEPS.length - 1 && (
              <div className={[
                'flex-1 h-0.5 mx-1 transition-all',
                done ? 'bg-green-500' : 'bg-gray-700',
              ].join(' ')} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Not connected gate ─────────────────────────────────────

function NotConnectedGate() {
  const openWallet = useWalletStore((s) => s.openWalletModal);
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-sm w-full text-center border border-gray-700 rounded-xl p-8 bg-gray-900">
        <div className="text-4xl mb-4">🔒</div>
        <h2 className="text-sm font-bold font-mono uppercase tracking-wider text-gray-200 mb-2">
          Wallet Required
        </h2>
        <p className="text-xs font-mono text-gray-500 mb-5">
          Connect your wallet to deploy an agent on AuditGuard.
        </p>
        <button
          onClick={() => openWallet({ action: 'deploy an agent' })}
          className="w-full py-2.5 text-xs font-bold font-mono uppercase tracking-wider rounded border border-cyan-500/50 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
        >
          Connect Wallet
        </button>
        <Link to="/dashboard" className="block mt-3 text-[11px] font-mono text-gray-600 hover:text-gray-400">
          ← Back to dashboard
        </Link>
      </div>
    </div>
  );
}

// ── Default form data ──────────────────────────────────────

function initialFormData() {
  return {
    identity: {
      agentId:     '',
      description: '',
      avatar:      'robot',
    },
    ucp: {
      ucpEndpoint: '',
      capabilities: ['TASK_ASSIGNMENT', 'BID_REQUEST', 'RESULT_SUBMISSION', 'STATUS_QUERY'],
      testStatus:  'idle',
      testLatency: null,
    },
    specializations: [],
    tier: 'COMMODITY',
  };
}

// ── AgentRegistration page ─────────────────────────────────

export default function AgentRegistration() {
  useBootstrap();

  const connected    = useWalletStore((s) => s.connectionStatus === 'connected');
  const guardBalance = useWalletStore((s) => s.guardBalance);

  const [step,       setStep]       = useState(1);
  const [formData,   setFormData]   = useState(initialFormData);
  const [errors,     setErrors]     = useState({});

  // Patch sub-sections of formData
  const patchIdentity       = (p) => setFormData((d) => ({ ...d, identity: { ...d.identity, ...p } }));
  const patchUcp            = (p) => setFormData((d) => ({ ...d, ucp: { ...d.ucp, ...p } }));
  const patchSpecialization = (p) => setFormData((d) => ({ ...d, ...p }));

  const patchErrors = (patch) => setErrors((e) => ({ ...e, ...patch }));

  // Validate current step and advance
  const handleNext = () => {
    let stepErrors = {};

    if (step === 1) {
      stepErrors = validateStep1(formData.identity);
      patchErrors(stepErrors);
      if (Object.values(stepErrors).some(Boolean)) return;
    }
    if (step === 2) {
      stepErrors = validateStep2(formData.ucp);
      patchErrors(stepErrors);
      if (Object.values(stepErrors).some(Boolean)) return;
    }
    if (step === 3) {
      stepErrors = validateStep3(formData);
      patchErrors(stepErrors);
      if (Object.values(stepErrors).some(Boolean)) return;
    }

    setStep((s) => Math.min(s + 1, 4));
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  // Called by StepDeploy if "Agent ID already taken" — jump back to step 1
  const handleReset = () => {
    setStep(1);
    setErrors({});
    patchIdentity({ agentId: '' });
  };

  const currentStepLabel = STEPS[step - 1]?.label ?? '';
  const isLastStep       = step === 4;

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100 overflow-hidden">
      <Header />

      {/* Sub-header */}
      <div className="flex-shrink-0 flex items-center gap-4 px-5 py-3 border-b border-gray-800 bg-gray-950">
        <Link
          to="/dashboard"
          className="flex items-center gap-1.5 text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← Dashboard
        </Link>
        <div className="h-4 w-px bg-gray-800" />
        <div className="flex items-center gap-2">
          <span className="text-cyan-400">🤖</span>
          <h1 className="text-sm font-bold font-mono uppercase tracking-widest text-gray-100">
            Deploy Your Agent
          </h1>
        </div>
        <div className="ml-auto">
          <WalletButton />
        </div>
      </div>

      {/* Main content */}
      {!connected ? (
        <NotConnectedGate />
      ) : (
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 py-6">

            {/* Step indicator */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-mono text-gray-500">
                  Step {step} of {STEPS.length}:{' '}
                  <span className="text-gray-300 font-semibold">{currentStepLabel}</span>
                </p>
                <p className="text-[10px] font-mono text-gray-600">
                  {STEPS.length - step} step{STEPS.length - step !== 1 ? 's' : ''} remaining
                </p>
              </div>
              <ProgressBar step={step} />
            </div>

            {/* Step content */}
            <div className="border border-gray-800 rounded-xl bg-gray-950 p-6 min-h-[420px]">
              <AnimatePresence mode="wait">
                {step === 1 && (
                  <motion.div
                    key="step1"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.18 }}
                  >
                    <StepIdentity
                      data={formData.identity}
                      setData={patchIdentity}
                      errors={errors}
                      setErrors={patchErrors}
                    />
                  </motion.div>
                )}

                {step === 2 && (
                  <motion.div
                    key="step2"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.18 }}
                  >
                    <StepUCP
                      data={formData.ucp}
                      setData={patchUcp}
                      errors={errors}
                      setErrors={patchErrors}
                    />
                  </motion.div>
                )}

                {step === 3 && (
                  <motion.div
                    key="step3"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.18 }}
                  >
                    <StepSpecialization
                      data={formData}
                      setData={patchSpecialization}
                      errors={errors}
                      guardBalance={guardBalance}
                    />
                  </motion.div>
                )}

                {step === 4 && (
                  <motion.div
                    key="step4"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.18 }}
                  >
                    <StepDeploy
                      formData={formData}
                      onReset={handleReset}
                      guardBalance={guardBalance}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Navigation */}
            {!isLastStep && (
              <div className="flex gap-3 mt-5">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={step === 1}
                  className="flex-1 py-2.5 rounded-lg border border-gray-700 text-xs font-mono text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  className="flex-1 py-2.5 rounded-lg border border-cyan-500/50 bg-cyan-500/10 text-xs font-bold font-mono uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/20 transition-colors"
                >
                  {step === 3 ? 'Review →' : 'Continue →'}
                </button>
              </div>
            )}

          </div>
        </main>
      )}
    </div>
  );
}
