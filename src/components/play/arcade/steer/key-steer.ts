/**
 * Rejd kláves (P36C T3): šipka vytočí řízení za ~0,25 s a puštění ho stejně
 * vrátí – jako volant, ne vypínač. Osa popojede o krok za každý odehraný tik
 * relace, takže do záznamu jde plynulá hodnota jako u tahu prstem a přehrání
 * je totéž. Žádné hodiny stránky: krok počítá jen rozdíl tiků.
 */

import { ARCADE_HZ, AXIS_MAX } from '@/play/arcade/contract';

import type { ArcadeSession } from '../session';

/** Krok za tik: z nuly na plný za čtvrt sekundy (15 tiků při 60 Hz). */
export const KEY_RAMP_PER_TICK = Math.ceil(AXIS_MAX / (ARCADE_HZ * 0.25));

export function rampToward(current: number, target: number, ticks: number): number {
  const step = KEY_RAMP_PER_TICK * ticks;
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

export interface KeySteer {
  axis(): number;
  /** Nový cíl (−AXIS_MAX..AXIS_MAX); první krok hned – nula by hodiny čekající na vstup nepustila. */
  aim(target: number): void;
  /** Okamžitě na střed (ztráta fokusu). */
  reset(): void;
  dispose(): void;
}

/** `onAxis` se zavolá po každé změně osy – tam ji vstup předá relaci (`hold`). */
export function keySteer(session: Pick<ArcadeSession, 'subscribe' | 'snapshot'>, onAxis: () => void): KeySteer {
  let axis = 0;
  let target = 0;
  let tick = session.snapshot().tick;
  const dispose = session.subscribe(() => {
    const now = session.snapshot().tick;
    const ticks = now - tick;
    tick = now;
    if (ticks < 0) {
      // Restart: nový běh začíná s volantem uprostřed.
      axis = 0;
      onAxis();
    } else if (ticks > 0 && axis !== target) {
      axis = rampToward(axis, target, ticks);
      onAxis();
    }
  });
  return {
    axis: () => axis,
    aim: (next) => {
      if (next === target) return;
      target = next;
      axis = rampToward(axis, target, 1);
      onAxis();
    },
    reset: () => {
      target = 0;
      axis = 0;
      onAxis();
    },
    dispose,
  };
}
