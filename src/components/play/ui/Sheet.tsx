'use client';

/**
 * List PLAY (P33 T3): na telefonu spodní list, na desktopu plovoucí karta
 * vpravo (rozvržení je v `play.css`). Zavře se Esc, klepnutím mimo a tahem
 * za hlavičku dolů; dokud je otevřený, drží fokus a po zavření ho vrátí
 * prvku, ze kterého se otevřel.
 *
 * Chování je v `holdSheet` nad dokumentem, ne v Reactu – sada testů nemá DOM
 * a list, který nevrátí fokus, na snímku vypadá správně.
 *
 * Vykresluje se do `.play-root` přes portál: karta výsledku má `transform`,
 * pod kterým by `position: fixed` listu přestal znamenat okno, a mimo
 * `.play-root` by list neviděl tokeny.
 */

import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from './IconButton';

/** Tah hlavičkou dolů delší než tohle list zavře. */
const DRAG_CLOSE_PX = 80;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Připojí chování otevřeného listu; vrací uvolnění, které vrátí fokus spouštěči. */
export function holdSheet(doc: Document, panel: HTMLElement, onClose: () => void): () => void {
  const trigger = doc.activeElement as HTMLElement | null;
  const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  (focusable()[0] ?? panel).focus();
  let dragFrom: number | null = null;

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) return;
    const active = doc.activeElement;
    const edge = event.shiftKey ? items[0] : items[items.length - 1];
    if (active === edge || !panel.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
  };
  const onDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!panel.contains(target)) {
      onClose();
      return;
    }
    dragFrom = target?.closest('[data-sheet-drag]') ? event.clientY : null;
  };
  const onUp = (event: PointerEvent) => {
    if (dragFrom !== null && event.clientY - dragFrom > DRAG_CLOSE_PX) onClose();
    dragFrom = null;
  };

  doc.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onDown);
  doc.addEventListener('pointerup', onUp);
  return () => {
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('pointerdown', onDown);
    doc.removeEventListener('pointerup', onUp);
    if (trigger?.isConnected) trigger.focus();
  };
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  className,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Rodič posílá novou funkci při každém vykreslení; list se kvůli tomu nesmí znovu připojit (fokus by skákal).
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => {
    if (!open || panel.current === null) return;
    return holdSheet(document, panel.current, () => latestClose.current());
  }, [open]);

  if (!open) return null;
  const sheet = (
    <div className="play-sheet-backdrop">
      <div ref={panel} className={className === undefined ? 'play-sheet' : `play-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="play-sheet-head" data-sheet-drag="">
          <span className="play-sheet-handle" aria-hidden="true" />
          <h2 className="play-sheet-title">{title}</h2>
          <IconButton aria-label="Close" icon="close" className="play-sheet-close" onClick={onClose} />
        </div>
        <div className="play-sheet-body">{children}</div>
      </div>
    </div>
  );
  const host = typeof document === 'undefined' ? null : document.querySelector('.play-root');
  return host === null ? sheet : createPortal(sheet, host);
}
