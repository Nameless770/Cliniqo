'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import styles from './Toast.module.css';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
};

type ToastInput = Omit<Toast, 'id'>;

const ToastContext = createContext<{
  show: (toast: ToastInput) => void;
  dismiss: (id: string) => void;
} | null>(null);

/**
 * Toast notifications.
 *
 * Two live regions, not one. Success and info go to a `polite` region so they wait for a
 * pause in speech; errors and warnings go to an `assertive` region so they interrupt.
 * A single region would either shout routine confirmations or bury failures.
 *
 * NEVER put patient data in a toast. "Appointment booked" is fine; "Appointment booked
 * for Sarah Ahmed, 14:30, diabetes review" puts PHI in a floating element that can be
 * screenshotted, read over a shoulder at a shared front desk, and announced aloud by a
 * screen reader. Reference the record, do not quote it.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      setToasts((current) => [...current, { ...input, id }]);

      /*
       * Errors and warnings do not auto-dismiss.
       *
       * A failed save that vanishes after four seconds is a failed save the clinician
       * did not see. Anything the user must act on stays until dismissed.
       */
      if (input.tone === 'success' || input.tone === 'info') {
        setTimeout(() => dismiss(id), 5000);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  const polite = toasts.filter((t) => t.tone === 'success' || t.tone === 'info');
  const assertive = toasts.filter((t) => t.tone === 'error' || t.tone === 'warning');

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div className={styles.region}>
        <div aria-live="polite" aria-relevant="additions">
          {polite.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
        <div aria-live="assertive" aria-relevant="additions">
          {assertive.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>.');
  }
  return context;
}

const TONE_LABEL: Record<ToastTone, string> = {
  success: 'Success',
  error: 'Error',
  warning: 'Warning',
  info: 'Information',
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className={[styles.toast, styles[toast.tone]].join(' ')}>
      <ToneIcon tone={toast.tone} />
      <div className={styles.content}>
        {/* The tone is stated in words, not conveyed by the border colour alone. */}
        <p className={styles.title}>
          <span className="sr-only">{TONE_LABEL[toast.tone]}: </span>
          {toast.title}
        </p>
        {toast.message ? <p className={styles.message}>{toast.message}</p> : null}
      </div>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => onDismiss(toast.id)}
      >
        <span className="sr-only">Dismiss {TONE_LABEL[toast.tone].toLowerCase()}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  const paths: Record<ToastTone, React.ReactNode> = {
    success: (
      <path
        d="M4 8.5l2.5 2.5L12 5.5"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    error: (
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" strokeWidth="1.75" strokeLinecap="round" />
    ),
    warning: <path d="M8 4.5v4M8 11v.5" strokeWidth="1.75" strokeLinecap="round" />,
    info: <path d="M8 7.5v4M8 4.8v.4" strokeWidth="1.75" strokeLinecap="round" />,
  };

  return (
    <svg
      className={styles.icon}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" strokeWidth="1.5" />
      {paths[tone]}
    </svg>
  );
}
