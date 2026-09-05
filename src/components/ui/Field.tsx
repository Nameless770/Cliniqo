import { cloneElement, isValidElement } from 'react';

import styles from './Field.module.css';

export type FieldProps = {
  /**
   * Required, not auto-generated.
   *
   * `useId` would make this a Client Component, which would push every form that uses it
   * across the client boundary. Forms in this app render patient data, so they stay
   * Server Components — an explicit id is a cheap price for that.
   */
  id: string;
  label: string;
  /** Supporting text. Announced before the error, via aria-describedby. */
  hint?: string;
  /** Presence of a message puts the control into the invalid state. */
  error?: string;
  required?: boolean;
  children: React.ReactElement<Record<string, unknown>>;
};

/**
 * Form field: label + control + hint + error, wired together.
 *
 * The wiring is the point. `htmlFor`/`id`, `aria-describedby`, `aria-invalid` and the
 * required marker are where form accessibility quietly breaks, so they are implemented
 * once here and cloned onto whatever control is passed in.
 *
 * The error is rendered in a `role="alert"` region so a screen reader announces it when
 * it appears after a failed submit, rather than leaving the user to hunt for it.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        // `required` drives the native constraint; aria-required covers controls where
        // the native attribute does not apply.
        required: required || undefined,
        'aria-required': required || undefined,
      })
    : children;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? (
          <>
            <span className={styles.required} aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>

      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      ) : null}

      {control}

      {error ? (
        <span className={styles.error} id={errorId} role="alert">
          <svg
            className={styles.errorIcon}
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M8 4.5v4.2M8 11.2v.6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          {error}
        </span>
      ) : null}
    </div>
  );
}
