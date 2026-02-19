import { useState } from 'react';
import { motion } from 'framer-motion';

// ── Avatar options ─────────────────────────────────────────

export const AVATAR_OPTIONS = [
  { id: 'robot',     emoji: '🤖', label: 'Robot'      },
  { id: 'arm',       emoji: '🦾', label: 'Cyber Arm'  },
  { id: 'dna',       emoji: '🧬', label: 'DNA'        },
  { id: 'search',    emoji: '🔍', label: 'Search'     },
  { id: 'shield',    emoji: '🛡',  label: 'Shield'     },
  { id: 'lightning', emoji: '⚡', label: 'Lightning'  },
  { id: 'target',    emoji: '🎯', label: 'Target'     },
  { id: 'scope',     emoji: '🔬', label: 'Scope'      },
];

// ── Validation ─────────────────────────────────────────────

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

function validateAgentId(value) {
  if (!value) return 'Agent ID is required.';
  if (value.length > 32) return 'Agent ID must be 32 characters or fewer.';
  if (!AGENT_ID_RE.test(value)) return 'Only letters, numbers, and hyphens. Must not start with a hyphen.';
  return null;
}

// ── Input + Textarea helpers ───────────────────────────────

function Field({ label, helper, error, children }) {
  return (
    <div>
      <label className="block text-xs font-bold font-mono uppercase tracking-wider text-gray-400 mb-1.5">
        {label}
      </label>
      {children}
      {helper && !error && (
        <p className="mt-1 text-[11px] font-mono text-gray-600">{helper}</p>
      )}
      {error && (
        <p className="mt-1 text-[11px] font-mono text-red-400">{error}</p>
      )}
    </div>
  );
}

// ── StepIdentity ───────────────────────────────────────────

/**
 * Step 1 — Agent Identity
 *
 * Props:
 *   data     { agentId, description, avatar }
 *   setData  (patch) => void
 *   errors   { agentId? }
 *   setErrors (patch) => void
 */
export default function StepIdentity({ data, setData, errors, setErrors }) {
  const [touched, setTouched] = useState({});

  const handleIdChange = (e) => {
    const val = e.target.value;
    setData({ agentId: val });
    if (touched.agentId) {
      setErrors({ agentId: validateAgentId(val) });
    }
  };

  const handleIdBlur = () => {
    setTouched((t) => ({ ...t, agentId: true }));
    setErrors({ agentId: validateAgentId(data.agentId) });
  };

  const charLeft = 200 - (data.description?.length || 0);

  return (
    <div className="space-y-6">

      {/* Agent ID */}
      <Field
        label="Agent ID *"
        helper="Choose a unique identifier. Alphanumeric + hyphens, max 32 chars."
        error={errors.agentId}
      >
        <input
          type="text"
          value={data.agentId}
          onChange={handleIdChange}
          onBlur={handleIdBlur}
          maxLength={32}
          placeholder="MyAuditAgent-1"
          className={[
            'w-full bg-gray-800 border rounded px-3 py-2.5 text-sm font-mono text-gray-100',
            'placeholder-gray-600 focus:outline-none transition-colors',
            errors.agentId
              ? 'border-red-500/60 focus:border-red-500'
              : 'border-gray-600 focus:border-cyan-500',
          ].join(' ')}
        />
        <div className="flex justify-end mt-0.5">
          <span className="text-[10px] font-mono text-gray-600">
            {data.agentId?.length || 0}/32
          </span>
        </div>
      </Field>

      {/* Description */}
      <Field
        label="Description (optional)"
        helper="Briefly describe what your agent does."
      >
        <textarea
          rows={3}
          value={data.description}
          onChange={(e) => setData({ description: e.target.value.slice(0, 200) })}
          placeholder="A static analysis agent specialising in DeFi contract vulnerabilities…"
          className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2.5 text-sm font-mono text-gray-100 placeholder-gray-600 focus:outline-none focus:border-cyan-500 transition-colors resize-none"
        />
        <div className="flex justify-end mt-0.5">
          <span className={`text-[10px] font-mono ${charLeft < 20 ? 'text-amber-400' : 'text-gray-600'}`}>
            {charLeft} remaining
          </span>
        </div>
      </Field>

      {/* Avatar picker */}
      <Field label="Icon (optional)">
        <div className="grid grid-cols-8 gap-2">
          {AVATAR_OPTIONS.map((opt) => {
            const selected = data.avatar === opt.id;
            return (
              <motion.button
                key={opt.id}
                type="button"
                whileTap={{ scale: 0.9 }}
                onClick={() => setData({ avatar: opt.id })}
                title={opt.label}
                className={[
                  'flex items-center justify-center h-10 rounded-lg text-xl border-2 transition-all',
                  selected
                    ? 'border-cyan-400 bg-cyan-500/15 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                    : 'border-gray-700 bg-gray-800 hover:border-gray-500',
                ].join(' ')}
              >
                {opt.emoji}
              </motion.button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] font-mono text-gray-600">
          Shown alongside your agent name on the leaderboard.
        </p>
      </Field>

      {/* Live preview */}
      {data.agentId && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="border border-gray-700 rounded-lg p-3 bg-gray-900"
        >
          <p className="text-[10px] font-mono text-gray-600 uppercase tracking-wider mb-2">Preview</p>
          <div className="flex items-center gap-2">
            <span className="text-xl">
              {AVATAR_OPTIONS.find((o) => o.id === data.avatar)?.emoji ?? '🤖'}
            </span>
            <span className="font-mono font-bold text-gray-100">{data.agentId}</span>
          </div>
          {data.description && (
            <p className="text-xs text-gray-500 font-mono mt-1 ml-8">{data.description}</p>
          )}
        </motion.div>
      )}
    </div>
  );
}

// ── Exported validator (used by parent to gate "Continue") ─

export function validateStep1(data) {
  const agentIdErr = validateAgentId(data.agentId);
  return { agentId: agentIdErr };
}
