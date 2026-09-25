/**
 * Pauza, když hráč odejde (P27B T3, P28B T6): skrytá záložka i okno bez
 * fokusu (přepnutí do jiné aplikace, klik do adresního řádku) hru zastaví.
 * Sama se nerozběhne: obnoví ji až vstup hráče, a to v zachytávací fázi,
 * takže ten stisk už do hry padne (u poletování je to rovnou mávnutí).
 */

import { isTyping } from './input';
import type { ArcadeSession } from './session';

type Listening = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Vrací odpojení. */
export function pauseWhenAway(session: Pick<ArcadeSession, 'pause' | 'resume' | 'paused'>, win: Listening, doc: Listening & { readonly visibilityState: DocumentVisibilityState }): () => void {
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') session.pause();
  };
  const onBlur = (): void => session.pause();
  const wake = (): void => {
    if (session.paused() && doc.visibilityState === 'visible') session.resume();
  };
  const onPointer = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('[data-testid="arcade-stage"]') !== null) wake();
  };
  const onKey = (event: Event): void => {
    // Klávesa do pole formuláře hru neobnoví – píše se tam věta, ne hraje.
    if (!(event as KeyboardEvent).repeat && !isTyping(event.target)) wake();
  };
  onVisibility();
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('blur', onBlur);
  win.addEventListener('pointerdown', onPointer, true);
  win.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('pointerdown', onPointer, true);
    win.removeEventListener('keydown', onKey, true);
  };
}
