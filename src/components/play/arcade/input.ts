/**
 * Sdílená pravidla vstupu her (P28B T1). Hry poslouchají klávesy na `window`,
 * takže bez téhle kontroly by si vzaly písmena a mezerník z pole remixu.
 */

/** Klávesa do pole formuláře patří větě, ne hře ani feedu. */
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);
