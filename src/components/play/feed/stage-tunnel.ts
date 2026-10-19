/**
 * Tunel scény do trvalého plátna feedu (P54A T5). `StageHost` drží po celou
 * dobu feedu jediný R3F `<Canvas>`; `ArcadeStage` s prop `host` místo vlastního
 * plátna pošle obsah scény sem a kontejner plátna si přesune na své místo v DOM.
 * Přechod mezi hrami tak mění jen scénu – WebGL kontext i programy three.js
 * zůstávají (dnes remount přes `key` = nový kontext a nová kompilace shaderů).
 *
 * Vlastník je ta scéna, která se připojila naposledy: karta další hry se může
 * připojit dřív, než předchozí odejde, a úklid předchozí pak nesmí smazat ji.
 */

import type { ReactNode } from 'react';

export type Frameloop = 'always' | 'demand';

export interface StageContent {
  /** Kdo scénu poslal – klíč obsahu, takže scéna další hry se připojí načisto, ne do stavu předchozí. */
  readonly owner: number;
  readonly node: ReactNode;
  readonly frameloop: Frameloop;
}

export interface StageTunnel {
  /** Trvalý kontejner plátna; `null` mimo prohlížeč. */
  readonly element: HTMLElement | null;
  /** Scéna vlastníka do plátna; volá se při každém vykreslení scény. */
  show(content: StageContent): void;
  /** Kontejner plátna do místa vlastníka (`slot` v `ArcadeStage`). */
  attach(owner: number, slot: HTMLElement): void;
  /** Vlastník odchází: scéna i kontejner pryč – jen když mezitím nepřišel jiný. */
  release(owner: number): void;
  content(): StageContent | null;
  subscribe(listener: () => void): () => void;
  /** Plátno umí zachytit, co právě ukazuje (`StageHost`, T8); `null` = plátno ještě/už není. */
  bind(capture: (() => Promise<Blob | null>) | null): void;
  /** Snímek scény, která odchází (`release`), dřív než ji vystřídá další – feed z něj dělá obrázek karty. */
  onLeave(listener: (frame: Promise<Blob | null>) => void): () => void;
}

export function createStageTunnel(element: HTMLElement | null): StageTunnel {
  let current: StageContent | null = null;
  let owner: number | null = null;
  let capture: (() => Promise<Blob | null>) | null = null;
  const leaving = new Set<(frame: Promise<Blob | null>) => void>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    element,
    show: (content) => {
      owner = content.owner;
      current = content;
      notify();
    },
    attach: (who, slot) => {
      owner = who;
      if (element !== null && element.parentNode !== slot) slot.appendChild(element);
    },
    release: (who) => {
      if (owner !== who) return;
      if (capture !== null && current !== null && leaving.size > 0) {
        const frame = capture();
        for (const listener of leaving) listener(frame);
      }
      owner = null;
      current = null;
      element?.remove();
      notify();
    },
    content: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind: (next) => {
      capture = next;
    },
    onLeave: (listener) => {
      leaving.add(listener);
      return () => {
        leaving.delete(listener);
      };
    },
  };
}
