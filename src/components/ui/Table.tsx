import styles from './Table.module.css';

/**
 * Table primitives.
 *
 * Thin wrappers over real table elements rather than a div grid, so that row/column
 * relationships, `scope`, and screen-reader table navigation all work natively.
 *
 * `TableContainer` is focusable and labelled: a horizontally scrolling region that is
 * not focusable cannot be scrolled by keyboard (WCAG 2.1.1). Clinical tables are wide
 * enough that this matters on every one of them.
 */

export function TableContainer({
  label,
  children,
}: {
  /** Names the scrollable region for screen readers, e.g. "Today's appointments". */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.scroll} tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

export function Table({
  caption,
  captionVisible = true,
  children,
}: {
  /** Every table gets a caption — visually hidden if the surrounding UI already says it. */
  caption: string;
  captionVisible?: boolean;
  children: React.ReactNode;
}) {
  return (
    <table className={styles.table}>
      <caption className={captionVisible ? styles.caption : 'sr-only'}>{caption}</caption>
      {children}
    </table>
  );
}

export type SortDirection = 'ascending' | 'descending' | 'none';

export function Th({
  children,
  scope = 'col',
  sort,
  onSort,
  align,
}: {
  children: React.ReactNode;
  scope?: 'col' | 'row';
  /** Omit for non-sortable columns. `aria-sort` is only valid when sorting exists. */
  sort?: SortDirection;
  onSort?: () => void;
  align?: 'numeric';
}) {
  return (
    <th
      scope={scope}
      className={[styles.th, align === 'numeric' ? styles.numeric : '']
        .filter(Boolean)
        .join(' ')}
      aria-sort={sort}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className={[styles.sortButton, sort && sort !== 'none' ? styles.sortActive : '']
            .filter(Boolean)
            .join(' ')}
        >
          {children}
          <span className={styles.sortIndicator} aria-hidden="true">
            {sort === 'ascending' ? '▲' : sort === 'descending' ? '▼' : '↕'}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Tr({ children }: { children: React.ReactNode }) {
  return <tr className={styles.row}>{children}</tr>;
}

export function Td({
  children,
  variant,
  colSpan,
}: {
  children: React.ReactNode;
  /** `numeric` for doses and counts, `identifier` for MRNs — both tabular-aligned. */
  variant?: 'numeric' | 'identifier';
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={[styles.td, variant ? styles[variant] : ''].filter(Boolean).join(' ')}
    >
      {children}
    </td>
  );
}
