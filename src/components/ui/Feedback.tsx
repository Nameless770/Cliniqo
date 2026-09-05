import styles from './Feedback.module.css';

/* ------------------------------------------------------------------ EmptyState */

/**
 * Empty state.
 *
 * An empty result and a failed query look identical to a user unless you say which it
 * is. In a clinical tool that distinction matters: "this patient has no recorded
 * allergies" and "we could not load allergies" must never render the same, because the
 * first reads as safe to proceed and the second is not.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <svg
        className={styles.emptyIcon}
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
        <path d="M3.5 9.5h17M8 13.5h8" strokeLinecap="round" />
      </svg>
      <p className={styles.emptyTitle}>{title}</p>
      {description ? <p className={styles.emptyBody}>{description}</p> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------------- Spinner */

/**
 * Loading indicator.
 *
 * `role="status"` plus a label. A bare animated circle communicates nothing to a screen
 * reader — the label is what makes it a loading indicator rather than decoration.
 */
export function Spinner({
  size = 'md',
  label = 'Loading',
}: {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}) {
  const sizeClass = {
    sm: styles.spinnerSm,
    md: styles.spinnerMd,
    lg: styles.spinnerLg,
  }[size];

  return (
    <span role="status">
      <span className={[styles.spinner, sizeClass].join(' ')} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.loading}>
      <Spinner size="lg" label={label} />
      <p aria-hidden="true">{label}</p>
    </div>
  );
}

/* -------------------------------------------------------------------- Skeleton */

/**
 * Skeleton placeholder.
 *
 * Decorative, and hidden from assistive technology — a screen reader announcing eight
 * grey rectangles is noise. Pair skeletons with a Spinner's live region, which is what
 * actually announces that something is loading.
 */
export function Skeleton({
  width = '100%',
  height = '1rem',
}: {
  width?: string;
  height?: string;
}) {
  return (
    <span className={styles.skeleton} style={{ width, height }} aria-hidden="true" />
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className={styles.skeletonStack} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          height="2.25rem"
          width={index === rows - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------- Badge */

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Status badge.
 *
 * The label is always a word. The dot and the colour reinforce it and never replace it —
 * "Life-threatening" must not be conveyed by red alone to a colourblind clinician.
 */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  const toneClass = {
    neutral: styles.badgeNeutral,
    success: styles.badgeSuccess,
    warning: styles.badgeWarning,
    danger: styles.badgeDanger,
    info: styles.badgeInfo,
  }[tone];

  return (
    <span className={[styles.badge, toneClass].join(' ')}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {children}
    </span>
  );
}
