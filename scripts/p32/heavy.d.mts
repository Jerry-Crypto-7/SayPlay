/** Typy k `heavy.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

import type { EventEmitter } from 'node:events';

export declare const DEFAULT_LOCK: string;

export declare function runHeavy(
  command: string[],
  options?: {
    lockDir?: string;
    pollMs?: number;
    reportMs?: number;
    staleMs?: number;
    log?: (line: string) => void;
    signals?: EventEmitter;
  },
): Promise<number>;
