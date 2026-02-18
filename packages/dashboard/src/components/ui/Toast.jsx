import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { create } from 'zustand';

// ── Internal Zustand store ─────────────────────────────────

let nextId = 0;

const useToastStore = create((set) => ({
  toasts: [],
  add: (toast) =>
    set((s) => ({
      toasts: [{ id: nextId++, ...toast }, ...s.toasts].slice(0, 3),
    })),
  remove: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// ── Public hook ────────────────────────────────────────────

/**
 * Returns { success, error, info } helpers to push toast notifications.
 *
 * @example
 *   const toast = useToast();
 *   toast.success('Delegated 50.00 GUARD to StaticAnalysis-47');
 */
export function useToast() {
  const add = useToastStore((s) => s.add);
  return {
    success: (message) => add({ type: 'success', message }),
    error:   (message) => add({ type: 'error',   message }),
    info:    (message) => add({ type: 'info',     message }),
  };
}

// ── Toast type config ──────────────────────────────────────

const TYPE_CONFIG = {
  success: {
    icon: '✓',
    border: 'border-green-500/50',
    bg:     'bg-green-500/10',
    text:   'text-green-300',
  },
  error: {
    icon: '✗',
    border: 'border-red-500/50',
    bg:     'bg-red-500/10',
    text:   'text-red-300',
  },
  info: {
    icon: '●',
    border: 'border-blue-400/50',
    bg:     'bg-blue-500/10',
    text:   'text-blue-300',
  },
};

// ── Individual toast ───────────────────────────────────────

function ToastItem({ toast, onRemove }) {
  const cfg = TYPE_CONFIG[toast.type] || TYPE_CONFIG.info;

  useEffect(() => {
    const id = setTimeout(() => onRemove(toast.id), 5000);
    return () => clearTimeout(id);
  }, [toast.id, onRemove]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.92 }}
      animate={{ opacity: 1, x: 0,  scale: 1 }}
      exit={{    opacity: 0, x: 60, scale: 0.92 }}
      transition={{ duration: 0.18 }}
      onClick={() => onRemove(toast.id)}
      className={[
        'flex items-start gap-3 rounded-lg border px-4 py-3 shadow-2xl',
        'max-w-sm w-full cursor-pointer select-none',
        cfg.border, cfg.bg,
      ].join(' ')}
    >
      <span className={`mt-0.5 text-sm font-bold flex-shrink-0 ${cfg.text}`}>{cfg.icon}</span>
      <p className="text-sm font-mono text-gray-200 leading-snug">{toast.message}</p>
    </motion.div>
  );
}

// ── Container (mount once per page) ───────────────────────

/**
 * Mount this once on any page that should display toasts.
 * Renders toasts in the bottom-right corner, stacked, max 3 visible.
 */
export function ToastContainer() {
  const toasts  = useToastStore((s) => s.toasts);
  const remove  = useToastStore((s) => s.remove);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 items-end pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} onRemove={remove} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
