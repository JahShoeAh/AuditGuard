import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ── UCP capability list ────────────────────────────────────

const UCP_CAPABILITIES = [
  {
    id: 'TASK_ASSIGNMENT',
    label: 'TASK_ASSIGNMENT',
    desc: 'Receive audit job assignments from the Orchestrator',
  },
  {
    id: 'BID_REQUEST',
    label: 'BID_REQUEST',
    desc: 'Calculate and submit bids for new jobs',
  },
  {
    id: 'RESULT_SUBMISSION',
    label: 'RESULT_SUBMISSION',
    desc: 'Submit audit findings on job completion',
  },
  {
    id: 'STATUS_QUERY',
    label: 'STATUS_QUERY',
    desc: 'Report current status to the Orchestrator',
  },
];

// ── URL validation ─────────────────────────────────────────

function validateUcpUrl(value) {
  if (!value) return 'UCP endpoint is required.';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return 'Endpoint must use HTTPS.';
    return null;
  } catch {
    return 'Enter a valid HTTPS URL (e.g. https://my-server.com/ucp/agent).';
  }
}

// ── Connection test statuses ───────────────────────────────

const TEST_IDLE     = 'idle';
const TEST_PENDING  = 'pending';
const TEST_OK       = 'ok';
const TEST_CORS     = 'cors';   // CORS blocks the browser fetch
const TEST_FAIL     = 'fail';   // non-200 or network error

// ── ConnectivityBadge ──────────────────────────────────────

function ConnectivityBadge({ testStatus, latency }) {
  if (testStatus === TEST_IDLE) return null;
  if (testStatus === TEST_PENDING) {
    return (
      <span className="text-[11px] font-mono text-guard-amber animate-pulse">
        Testing…
      </span>
    );
  }
  if (testStatus === TEST_OK) {
    return (
      <span className="text-[11px] font-mono text-green-400">
        ✓ Agent responded ({latency}ms)
      </span>
    );
  }
  if (testStatus === TEST_CORS) {
    return (
      <span className="text-[11px] font-mono text-amber-400">
        ⚠ Could not verify from browser (CORS). Ensure your agent is running and accessible from the Hedera network.
      </span>
    );
  }
  return (
    <span className="text-[11px] font-mono text-red-400">
      ✗ No response — is your agent running?
    </span>
  );
}

/**
 * Run a health-check POST to {endpoint}/health.
 * Returns { status: TEST_OK | TEST_CORS | TEST_FAIL, latency? }
 */
async function runConnectivityTest(endpoint) {
  const healthUrl = endpoint.replace(/\/$/, '') + '/health';
  const start = Date.now();
  try {
    const res = await fetch(healthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'HEALTH_CHECK' }),
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - start;
    if (res.ok) return { status: TEST_OK, latency };
    return { status: TEST_FAIL };
  } catch (err) {
    if (
      err?.message?.toLowerCase().includes('cors') ||
      err?.name === 'TypeError'
    ) {
      return { status: TEST_CORS };
    }
    return { status: TEST_FAIL };
  }
}

// ── StepUCP ────────────────────────────────────────────────

/**
 * Step 2 — OpenClaw UCP Configuration
 *
 * Props:
 *   data       { ucpEndpoint, capabilities, testStatus, testLatency }
 *   setData    (patch) => void
 *   errors     { ucpEndpoint? }
 *   setErrors  (patch) => void
 */
export default function StepUCP({ data, setData, errors, setErrors }) {
  const [touched, setTouched] = useState(false);

  const handleUrlChange = (e) => {
    const val = e.target.value;
    setData({ ucpEndpoint: val, testStatus: TEST_IDLE, testLatency: null });
    if (touched) setErrors({ ucpEndpoint: validateUcpUrl(val) });
  };

  const handleUrlBlur = () => {
    setTouched(true);
    setErrors({ ucpEndpoint: validateUcpUrl(data.ucpEndpoint) });
  };

  const handleTest = async () => {
    const urlErr = validateUcpUrl(data.ucpEndpoint);
    if (urlErr) {
      setTouched(true);
      setErrors({ ucpEndpoint: urlErr });
      return;
    }
    setData({ testStatus: TEST_PENDING, testLatency: null });
    const result = await runConnectivityTest(data.ucpEndpoint);
    setData({ testStatus: result.status, testLatency: result.latency ?? null });
  };

  const toggleCapability = (id) => {
    const next = data.capabilities.includes(id)
      ? data.capabilities.filter((c) => c !== id)
      : [...data.capabilities, id];
    setData({ capabilities: next });
  };

  return (
    <div className="space-y-6">

      {/* Endpoint URL */}
      <div>
        <label className="block text-xs font-bold font-mono uppercase tracking-wider text-gray-400 mb-1.5">
          UCP Endpoint URL *
        </label>

        <div className="flex gap-2">
          <input
            type="url"
            value={data.ucpEndpoint}
            onChange={handleUrlChange}
            onBlur={handleUrlBlur}
            placeholder="https://my-server.com/ucp/agent"
            className={[
              'flex-1 bg-gray-800 border rounded px-3 py-2.5 text-sm font-mono text-gray-100',
              'placeholder-gray-600 focus:outline-none transition-colors',
              errors.ucpEndpoint
                ? 'border-red-500/60 focus:border-red-500'
                : 'border-gray-600 focus:border-guard-amber',
            ].join(' ')}
          />
          <button
            type="button"
            onClick={handleTest}
            disabled={data.testStatus === TEST_PENDING}
            className="flex-shrink-0 px-3 py-2 text-[11px] font-bold font-mono uppercase tracking-wider rounded border border-guard-amber/40 bg-guard-amber/10 text-guard-amber hover:bg-guard-amber/20 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {data.testStatus === TEST_PENDING ? '…' : 'Test Connection'}
          </button>
        </div>

        <div className="mt-1.5 min-h-[18px]">
          {errors.ucpEndpoint ? (
            <p className="text-[11px] font-mono text-red-400">{errors.ucpEndpoint}</p>
          ) : (
            <ConnectivityBadge testStatus={data.testStatus} latency={data.testLatency} />
          )}
        </div>

        <p className="mt-1 text-[11px] font-mono text-gray-600">
          Your agent must be running an OpenClaw-compatible UCP service at this URL.
          The Orchestrator will send task assignments here.
        </p>
      </div>

      {/* CORS advisory (persistent if CORS was hit) */}
      <AnimatePresence>
        {data.testStatus === TEST_CORS && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="border border-amber-500/30 rounded-lg p-3 bg-amber-500/5 text-xs font-mono text-amber-300"
          >
            <p className="font-bold mb-1">Browser CORS restriction</p>
            <p>
              Browser security blocked the test request. This doesn&apos;t mean your agent
              is down — it may simply not send CORS headers. The Hedera Orchestrator
              calls your endpoint server-to-server and is not affected by CORS.
              You can safely continue registration.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* UCP Capabilities checklist */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold font-mono uppercase tracking-wider text-gray-400">
            UCP Message Types — Confirm Support
          </p>
          <a
            href="https://github.com/openclaw/ucp-spec"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-mono text-guard-amber hover:text-amber-300"
          >
            Read the OpenClaw UCP specification →
          </a>
        </div>

        <p className="text-[11px] font-mono text-gray-500 mb-3">
          Your agent should support these message types to participate fully in the marketplace.
          This is informational only — not enforced on-chain.
        </p>

        <div className="space-y-2">
          {UCP_CAPABILITIES.map((cap) => {
            const checked = data.capabilities.includes(cap.id);
            return (
              <label
                key={cap.id}
                className={[
                  'flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-all',
                    checked
                    ? 'border-guard-amber/40 bg-guard-amber/5'
                    : 'border-gray-700 bg-gray-900 hover:border-gray-600',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleCapability(cap.id)}
                  className="mt-0.5 accent-amber-400 w-4 h-4 flex-shrink-0"
                />
                <div>
                  <span className="text-xs font-bold font-mono text-gray-200">{cap.label}</span>
                  <p className="text-[11px] font-mono text-gray-500 mt-0.5">{cap.desc}</p>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function validateStep2(data) {
  return { ucpEndpoint: validateUcpUrl(data.ucpEndpoint) };
}
