/**
 * Hra čeká na první dotek (P33 T11): scéna se kreslí, hodiny stojí, dokud se
 * hráč nedotkne plátna nebo nestiskne klávesu – runner by jinak prohrál dřív,
 * než hráč pochopí ovládání. Obal hodin jako `holdUntilRapier`: stisky z
 * čekání padnou do tiku 0, takže záznam začíná prvním vstupem hráče a
 * přehrání je totéž jako bez čekání. Ukázka robota nečeká; restart (Play
 * again, Stop and play) čeká znovu.
 */

import { isTyping } from './input';
import type { ArcadeSession } from './session';

export interface ReadyGate {
  /** Pustí hodiny – ťuk na scénu nebo klávesa, i když ovládání z nich nic nezapíše. */
  begin(): void;
  waiting(): boolean;
  /**
   * Ruční hodiny pro sondu e2e (P36C T4): snímky čas neposouvají, tiky odtiká
   * jen `stepOnce` testu. Gesta hraje skutečný dotyk, jen čas je deterministický.
   */
  manualClock(on: boolean): void;
}

export function holdUntilTouch(session: ArcadeSession): ArcadeSession & ReadyGate {
  let waiting = true;
  let manual = false;
  // Konec čekání se ohlásí odběratelům relace (P68R T3): scéna, která do prvního doteku kreslí na požádání, se tím probudí.
  const listeners = new Set<() => void>();
  return {
    ...session,
    advance: (ms) => (manual || (waiting && session.demo() === null) ? 0 : session.advance(ms)),
    subscribe: (listener) => {
      listeners.add(listener);
      const off = session.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    restart: () => {
      waiting = true;
      session.restart();
    },
    begin: () => {
      if (!waiting) return;
      waiting = false;
      for (const listener of [...listeners]) listener();
    },
    waiting: () => waiting,
    manualClock: (on) => {
      manual = on;
    },
  };
}

/** Klávesy, které patří stránce: fokus, zavření listu a samotné modifikátory. */
const PAGE_KEYS = new Set(['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/**
 * Prvek, na kterém dotek ani klávesa hru nepustí (P73B T3): řádek „Checked“ na kartě startu a list
 * „Why this game is fair“, který otevře – hráč si čte, hodiny stojí dál.
 */
const KEEPS_WAITING = '[data-keeps-waiting], .play-fair-sheet';

export const keepsWaiting = (target: EventTarget | null): boolean => target instanceof HTMLElement && target.closest(KEEPS_WAITING) !== null;

/** Klávesa, která hru pustí: ne v poli formuláře, ne zkratka prohlížeče, ne opakování. */
export function wakesGame(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>): boolean {
  return !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !PAGE_KEYS.has(event.key) && !isTyping(event.target) && !keepsWaiting(event.target);
}

/** Stav hry v DOM (`data-state` na `play-game`, P85): automat čte hru z atributu, ne z plátna. */
export type PlayState = 'loading' | 'ready' | 'running' | 'paused' | 'demo' | 'won' | 'lost';

/**
 * Stav hry v pořadí přednosti: kód scény nebo fyzika ještě nedorazily, hraje ukázka robota (ani její konec
 * není výsledek hráče), běh skončil, pauza, hodiny stojí na prvním doteku (`ready`), jinak běh.
 * Konec bez výhry je `lost` i u poruchy mřížky (`runtimeFault`) – karta výsledku ho ukáže jako prohru.
 */
export function playStateOf(game: {
  readonly loading: boolean;
  readonly demo: boolean;
  readonly runState: string;
  readonly paused: boolean;
  readonly waiting: boolean;
}): PlayState {
  if (game.loading) return 'loading';
  if (game.demo) return 'demo';
  if (game.runState !== 'running') return game.runState === 'won' ? 'won' : 'lost';
  if (game.paused) return 'paused';
  return game.waiting ? 'ready' : 'running';
}
