/**
 * Náhled robota pro kartu feedu (P54A T7) a sonda `window.__playFeed()`.
 *
 * Hra publikovaná od P54A nese `preview` v detailu; starší ho dostane z
 * `bot-worker.ts` – `runBot` stojí na hlavním vlákně 21–685 ms a telefon by
 * při přechodu zamrzl. Výsledek workeru se drží v paměti stránky, takže se
 * každá hra počítá nejvýš jednou. Selhání workeru = `null`: karta pak hraje
 * bez náhledu (hra čeká na první dotek).
 */

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { FeedPreview } from '@/play/version/version';

import type { BotWorkerRequest, BotWorkerResponse } from './bot-worker';

const computed = new Map<string, Promise<FeedPreview | null>>();
let worker: Worker | null = null;
const waiting = new Map<string, (preview: FeedPreview | null) => void>();

function botWorker(): Worker {
  if (worker !== null) return worker;
  // `new URL(..., import.meta.url)` webpack pozná a worker zabalí (vzor `src/shape/mesh-client.ts`).
  const created = new Worker(new URL('./bot-worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<BotWorkerResponse>) => {
    const answer = event.data;
    waiting.get(answer.versionId)?.('preview' in answer ? answer.preview : null);
    waiting.delete(answer.versionId);
  };
  created.onerror = () => {
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
    worker = null;
  };
  worker = created;
  return created;
}

/** Náhled hry: uložený z publikace, jinak spočtený ve workeru. */
export function previewFor(versionId: string, stored: FeedPreview | undefined, world: ArcadeWorld): Promise<FeedPreview | null> {
  if (stored !== undefined) return Promise.resolve(stored);
  const known = computed.get(versionId);
  if (known !== undefined) return known;
  const job = new Promise<FeedPreview | null>((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve(null);
      return;
    }
    waiting.set(versionId, resolve);
    botWorker().postMessage({ versionId, world } satisfies BotWorkerRequest);
  });
  computed.set(versionId, job);
  return job;
}

/** `still` = hra stojí na tiku 0 a čeká na první dotek (méně pohybu, nebo hra bez náhledu). */
export type FeedMode = 'preview' | 'still' | 'play' | 'result';

/** Hráč kartu ještě nepřevzal: tah posouvá feed a sloupec akcí je vidět. */
export const untaken = (mode: FeedMode): boolean => mode === 'preview' || mode === 'still';

export interface FeedProbe {
  readonly versionId: string | null;
  readonly mode: FeedMode;
  readonly tick: number;
  /** Kolik různých pláten feed za dobu stránky ukázal – jedno trvalé plátno = 1. */
  readonly contexts: number;
}

declare global {
  interface Window {
    __playFeed?: () => FeedProbe;
  }
}

const seen = new WeakSet<HTMLCanvasElement>();
let canvases = 0;

/** Plátna feedu, která se kdy objevila; volá se při každém přechodu i z sondy. */
export function countCanvases(root: ParentNode): number {
  for (const canvas of root.querySelectorAll('canvas')) {
    if (seen.has(canvas)) continue;
    seen.add(canvas);
    canvases += 1;
  }
  return canvases;
}

/**
 * Režim aktivní karty z DOM: výsledek běhu hráče, náhled robota (poznámka
 * ukázky `play-demo` – v kartě skrytá, karta ukazuje „Tap to play“), jinak
 * hraje hráč. Karta, jejíž hra se ještě načítá, je náhled – hráč ji nepřevzal.
 */
export function feedMode(card: Element | null): FeedMode {
  if (card === null || card.querySelector('.play-shell') === null) return 'preview';
  if (card.querySelector('[data-testid="play-outcome"]') !== null) return 'result';
  if (card.querySelector('[data-testid="play-demo"]') !== null) return 'preview';
  // Jen karta bez náhledu kvůli méně pohybu (`data-still`): po převzetí náhledu stojí tik na 0 taky.
  if (card.getAttribute('data-still') === 'true' && card.querySelector('[data-testid="play-first-prompt"]') !== null) return 'still';
  return 'play';
}
