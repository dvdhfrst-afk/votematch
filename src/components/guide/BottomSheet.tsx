'use client';

/**
 * BottomSheet — the guide's single overlay container.
 *
 * Design law (ds-README non-negotiable 1): "Bottom sheets, not modals." Every
 * on-demand overlay in the voter flow (SPI consent, the scope sheet, the F3
 * match-nuance sentence, "+ N more sources") slides up from the bottom rather
 * than centering as a dialog. This is the shared client wrapper WAVE-2 agents
 * mount around their own sheet bodies.
 *
 * Behavior (ds-interactions 3e):
 *   · slide up + scrim fade-in, slow (~320ms); cross-fade only under
 *     prefers-reduced-motion (handled in globals.css .civic-sheet*).
 *   · closes on Escape, scrim click, and the drag-handle/close button.
 *   · locks body scroll while open; restores focus to the opener on close.
 *   · corners rounded top-only on mobile; centered + capped width on >=768.
 *
 * This component is display + interaction only. It holds no product state —
 * the caller owns `open`/`onClose` so the sheet composes with any trigger.
 */

import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible title — rendered as the sheet heading and used for aria-labelledby. */
  title: string;
  children: ReactNode;
  /** Optional footer region pinned below the scroll area (e.g. a sticky CTA). */
  footer?: ReactNode;
}

export function BottomSheet({ open, onClose, title, children, footer }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const headingId = useId();

  // Remember the opener, lock scroll, move focus in, restore on close.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the panel so screen readers land inside and Escape works.
    const raf = requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      document.body.style.overflow = prevOverflow;
      cancelAnimationFrame(raf);
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, [open]);

  // Escape to close + a minimal focus trap (keep Tab inside the panel).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="civic-sheet-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="civic-sheet-panel"
      >
        {/* Drag handle — also a large tap target that closes the sheet */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="civic-sheet-handle"
        >
          <span aria-hidden="true" className="civic-sheet-grip" />
        </button>

        <div className="civic-sheet-head">
          <h2
            id={headingId}
            className="civic-serif"
            style={{ fontSize: 18, fontWeight: 700, color: 'var(--civic-text)', margin: 0 }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="civic-sheet-close"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="civic-sheet-body">{children}</div>

        {footer ? <div className="civic-sheet-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export default BottomSheet;
