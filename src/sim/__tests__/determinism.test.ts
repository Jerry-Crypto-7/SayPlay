import { describe, expect, it } from 'vitest';

import { TICK_DT, TICK_HZ, TICK_MS, createClock, pump, runTicks } from '../clock';
import { hashHex, hashWords } from '../hash';
import { SUBSYSTEMS, createStreams, nextInt } from '../rng';
import { createState, defineLayout, readSlot, writeSlot } from '../state';

const LAYOUT = defineLayout([
  { id: 'collected', kind: 'counter', min: 0, max: 999, initial: 0 },
  { id: 'charge', kind: 'counter', min: -50, max: 50, initial: -50 },
  { id: 'alarm', kind: 'flag', min: 0, max: 1, initial: 0 },
  { id: 'fuse', kind: 'timer', min: 0, max: 400, initial: 0 },
  { id: 'door', kind: 'enum', min: 0, max: 2, initial: 1 },
]);

/**
 * Hračkový svět. Skutečný interpret staví až T9 — tady jde jen o to, aby hodiny,
 * PRNG a zabalený stav byly zapojené do jedné smyčky, jejímž jediným výstupem je
 * hash. Každý ze čtyř streamů se spotřebovává, takže záměna streamů se na hashi
 * projeví.
 */
function runWorld(seed: number, ticks: number): Uint32Array {
  const clock = createClock();
  const streams = createStreams(seed);
  const state = createState(LAYOUT);

  runTicks(clock, ticks, (tick) => {
    writeSlot(LAYOUT, state, 'collected', readSlot(LAYOUT, state, 'collected') + nextInt(streams.spawn, 0, 3));
    writeSlot(LAYOUT, state, 'charge', readSlot(LAYOUT, state, 'charge') + nextInt(streams.ai, -2, 2));
    writeSlot(LAYOUT, state, 'alarm', nextInt(streams.effect, 0, 1));
    writeSlot(LAYOUT, state, 'door', nextInt(streams.layout, 0, 2));
    writeSlot(LAYOUT, state, 'fuse', tick % 401);
  });

  return state;
}

describe('tikové hodiny', () => {
  it('mají jedinou frekvenci a odvozený krok', () => {
    expect(TICK_HZ).toBe(20);
    expect(TICK_DT).toBe(0.05);
    expect(TICK_MS).toBe(50);
  });

  it('převedou nástěnný čas na celé tiky a zbytek si nechají', () => {
    const clock = createClock();

    expect(pump(clock, 1000)).toBe(20);
    expect(clock.accumulatorMs).toBe(0);

    expect(pump(clock, 30)).toBe(0);
    expect(clock.accumulatorMs).toBe(30);

    // Zbytek se nesmí zahodit — jinak by hustota pumpování měnila počet tiků.
    expect(pump(clock, 30)).toBe(1);
    expect(clock.accumulatorMs).toBe(10);
  });

  it('zvyšují `tick` výhradně v `runTicks`', () => {
    const clock = createClock();
    const seen: number[] = [];

    pump(clock, 5000);
    expect(clock.tick).toBe(0);

    runTicks(clock, 3, (tick) => seen.push(tick));
    expect(seen).toEqual([0, 1, 2]);
    expect(clock.tick).toBe(3);
  });
});

describe('seedovaná PRNG', () => {
  it('dá pro stejný seed stejnou posloupnost', () => {
    const first = createStreams(20260812);
    const second = createStreams(20260812);

    for (let i = 0; i < 64; i += 1) {
      expect(nextInt(first.spawn, 0, 1_000_000)).toBe(nextInt(second.spawn, 0, 1_000_000));
    }
  });

  it('drží streamy subsystémů oddělené', () => {
    const streams = createStreams(20260812);
    const heads = SUBSYSTEMS.map((subsystem) => nextInt(streams[subsystem], 0, 1_000_000_000));
    expect(new Set(heads).size).toBe(SUBSYSTEMS.length);
  });

  it('spotřeba jednoho streamu neposune ostatní', () => {
    const untouched = createStreams(20260812);
    const drained = createStreams(20260812);

    for (let i = 0; i < 500; i += 1) {
      nextInt(drained.spawn, 0, 9);
    }

    expect(nextInt(drained.ai, 0, 1_000_000)).toBe(nextInt(untouched.ai, 0, 1_000_000));
    expect(nextInt(drained.layout, 0, 1_000_000)).toBe(nextInt(untouched.layout, 0, 1_000_000));
  });
});

describe('hash zabaleného stavu', () => {
  it('sedí na zafixované FNV-1a hodnoty', () => {
    // Zlaté hodnoty zamykají algoritmus. Kdyby se změnil, hashe ve svědcích a
    // v certifikátech přestanou platit napříč celým projektem — tichá změna je
    // horší než rozbitý test.
    expect(hashWords(new Uint32Array(0))).toBe(2166136261);
    expect(hashWords(new Uint32Array(4))).toBe(1768495365);
    expect(hashWords(Uint32Array.from([1, 2, 3]))).toBe(2034659765);
    expect(hashWords(Uint32Array.from([0xffffffff]))).toBe(3809873841);
    expect(hashHex(new Uint32Array(0))).toBe('811c9dc5');
  });

  it('rozliší záměnu dvou slov', () => {
    expect(hashWords(Uint32Array.from([1, 2]))).not.toBe(hashWords(Uint32Array.from([2, 1])));
  });
});

describe('zabalený stav', () => {
  it('unese čítač se záporným dolním mezníkem', () => {
    const state = createState(LAYOUT);
    expect(readSlot(LAYOUT, state, 'charge')).toBe(-50);

    writeSlot(LAYOUT, state, 'charge', -7);
    expect(readSlot(LAYOUT, state, 'charge')).toBe(-7);
  });

  it('clampuje zápis na deklarované meze', () => {
    const state = createState(LAYOUT);

    writeSlot(LAYOUT, state, 'collected', 5000);
    expect(readSlot(LAYOUT, state, 'collected')).toBe(999);

    writeSlot(LAYOUT, state, 'charge', -900);
    expect(readSlot(LAYOUT, state, 'charge')).toBe(-50);
  });

  it('odmítne vadné rozvržení', () => {
    expect(() =>
      defineLayout([
        { id: 'a', kind: 'flag', min: 0, max: 1, initial: 0 },
        { id: 'a', kind: 'flag', min: 0, max: 1, initial: 0 },
      ]),
    ).toThrow(/duplicate slot id/);

    expect(() => defineLayout([{ id: 'b', kind: 'counter', min: 0, max: 3, initial: 9 }])).toThrow(
      /initial value outside/,
    );
  });
});

describe('determinismus jádra', () => {
  it('dá pro stejný seed identický hash přes 1 000 tiků', () => {
    const first = runWorld(20260812, 1000);
    const second = runWorld(20260812, 1000);

    expect(hashHex(first)).toBe(hashHex(second));
  });

  it('dá pro jiný seed jiný hash', () => {
    // Bez tohohle by AC splnil i svět, který PRNG vůbec nečte.
    expect(hashHex(runWorld(20260812, 1000))).not.toBe(hashHex(runWorld(20260813, 1000)));
  });

  it('je citlivý na počet odkrokovaných tiků', () => {
    expect(hashHex(runWorld(20260812, 999))).not.toBe(hashHex(runWorld(20260812, 1000)));
  });
});
