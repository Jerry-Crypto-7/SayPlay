/**
 * Odesílání událostí herní smyčky z prohlížeče (P27D T4). Kontrakt a počítání
 * jsou v `src/play/loop-events.ts`; tady je jen id relace záložky, jednorázové
 * události a odeslání, které nepočká na odpověď ani nepřežije chybu.
 *
 * Sdílený odkaz nese `?via=share` (`ShareButton`): otevření takového odkazu je
 * `shared_open`, což je jediný doklad, že odkaz někam došel – samotná nabídka
 * sdílení to není.
 */

import type { LoopEventName } from '@/play/loop-events';

export const SHARE_MARK = 'via=share';

const ONCE: ReadonlySet<LoopEventName> = new Set(['impression', 'first_input', 'shared_open']);
const sent = new Set<string>();
let memorySession: string | null = null;

function freshSession(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}

/** Id relace záložky: přežije přechod mezi hrami i obnovení stránky, ne novou záložku. */
function session(): string {
  try {
    const stored = sessionStorage.getItem('play-loop-session');
    if (stored !== null) return stored;
    const created = freshSession();
    sessionStorage.setItem('play-loop-session', created);
    return created;
  } catch {
    // Úložiště zakázané (Safari private): id jen na dobu stránky.
    memorySession ??= freshSession();
    return memorySession;
  }
}

export function loopEvent(name: LoopEventName, versionId: string, extra?: { readonly withClip: boolean }): void {
  if (typeof window === 'undefined') return;
  const id = session();
  if (ONCE.has(name)) {
    const key = `${name}|${versionId}`;
    if (sent.has(key)) return;
    sent.add(key);
  }
  const body = JSON.stringify({ name, versionId, session: id, ...extra });
  try {
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/play/events', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/play/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    // Statistika nesmí hru shodit.
  }
}

/** Zobrazení hry; otevřená ze sdíleného odkazu navíc `shared_open`. */
export function loopImpression(versionId: string): void {
  loopEvent('impression', versionId);
  if (window.location.search.includes(SHARE_MARK) && window.location.pathname.endsWith(`/play/${versionId}`)) loopEvent('shared_open', versionId);
}
