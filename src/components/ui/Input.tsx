import { forwardRef } from 'react';

import styles from './Input.module.css';

/**
 * Bare form controls.
 *
 * These do not render their own label. Labels, hints, and errors are `Field`'s job,
 * because the wiring between them (`htmlFor`, `aria-describedby`, `aria-invalid`) is
 * where accessibility bugs live and it should exist in exactly one place.
 *
 * Use `<Field>` in application code. Reach for these directly only inside another
 * primitive.
 */

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      className={[styles.control, className ?? ''].filter(Boolean).join(' ')}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      {...rest}
      ref={ref}
      className={[styles.control, styles.textarea, className ?? '']
        .filter(Boolean)
        .join(' ')}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  return (
    <select
      {...rest}
      ref={ref}
      className={[styles.control, styles.select, className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </select>
  );
});
