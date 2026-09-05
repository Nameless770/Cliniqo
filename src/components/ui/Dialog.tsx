'use client';

import { useEffect, useRef } from 'react';

import styles from './Dialog.module.css';

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  id: string;
  title: string;
  description?: string;
  wide?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

/**
 * Modal dialog, built on the native <dialog> element.
 *
 * `showModal()` gives us focus trapping, Escape-to-close, restoring focus to the trigger
 * on close, and `inert` on the rest of the page — all from the platform. Hand-rolled
 * modals get some of that list right and quietly ship the rest broken; the ones that
 * usually break are focus restoration and background inertness.
 *
 * A Client Component, necessarily: it manages open/close state. Keep PHI out of its
 * props beyond what is actually rendered — anything passed here is serialised into the
 * page payload.
 */
export function Dialog({
  open,
  onClose,
  id,
  title,
  description,
  wide = false,
  children,
  footer,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Fires for Escape as well as close(); keeps React state in step with the platform.
    const handleClose = () => onClose();
    node.addEventListener('close', handleClose);
    return () => node.removeEventListener('close', handleClose);
  }, [onClose]);

  const titleId = `${id}-title`;
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <dialog
      ref={ref}
      id={id}
      className={[styles.dialog, wide ? styles.wide : ''].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      /* Click on the backdrop closes. The check is that the click landed on the dialog
         element itself rather than its contents — ::backdrop is not a separate node. */
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className={styles.header}>
        <div>
          <h2 className={styles.title} id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className={styles.description} id={descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        <button type="button" className={styles.close} onClick={onClose}>
          <span className="sr-only">Close dialog</span>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className={styles.body}>{children}</div>

      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </dialog>
  );
}
