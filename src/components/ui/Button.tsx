import { forwardRef } from 'react';

import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  /** Shows a spinner and blocks interaction. Keeps the label — never a bare spinner. */
  loading?: boolean;
};

/**
 * Button.
 *
 * Renders a real <button>, so Enter/Space, form submission, and the disabled state all
 * come from the platform rather than being re-implemented.
 *
 * While `loading`, the button stays in the tab order and keeps its accessible name; it
 * is marked `aria-busy` and blocked via `disabled`. Replacing the label with a spinner
 * would leave a screen-reader user with an unnamed control mid-submit.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    loading = false,
    disabled,
    children,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={[
        styles.button,
        styles[variant],
        styles[size],
        fullWidth ? styles.fullWidth : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
