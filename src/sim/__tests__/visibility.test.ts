import { describe, expect, it } from 'vitest';

import { MAX_CATCHUP_TICKS, TICK_MS, createClock, pump, runTicks } from '../clock';
import { hashHex } from '../hash';
import { createStreams, nextInt } from '../rng';
import { createState, defineLayout, readSlot, writeSlot } from '../state';

const LAYOUT = defineLayout([
  { id: 'collected', kind: 'counter', min: 0, max: 99_999, initial: 0 },
  { id: 'phase', kind: 'enum', min: 0, max: 3, initial: 0 },
]);

const SEED = 20260812;

interface World {
  clock: ReturnType<typeof createClock>;
  streams: ReturnType<typeof createStreams>;
  state: Uint32Array;
}

function createWorld(): World {
  return { clock: createClock(), streams: createStreams(SEED), state: createState(LAYOUT) };
}

function step(world: World, count: number): void {
  runTicks(world.clock, count, (tick) => {
    writeSlot(
      LAYOUT,
      world.state,
      'collected',
      readSlot(LAYOUT, world.state, 'collected') + nextInt(world.streams.spawn, 0, 3),
    );
    writeSlot(LAYOUT, world.state, 'phase', tick % 4);
  });
}

describe('uspaná záložka', () => {
  it('posune svět o celočíselný, shora omezený počet tiků', () => {
    const clock = createClock();

    // Třicet sekund nástěnného času je 600 tiků. Bez stropu by se všech 600
    // odkrokovalo v jednom snímku.
    const due = pump(clock, 30_000);

    expect(Number.isInteger(due)).toBe(true);
    expect(due).toBe(MAX_CATCHUP_TICKS);
    expect(clock.droppedTicks).toBe(30_000 / TICK_MS - MAX_CATCHUP_TICKS);
  });

  it('zahozený přebytek se nevrátí příštím pumpnutím', () => {
    const clock = createClock();
    pump(clock, 30_000);

    // Kdyby přebytek zůstal v akumulátoru, strop by spirálu jen rozložil do
    // dalších snímků místo aby ji uťal.
    expect(clock.accumulatorMs).toBe(0);
    expect(pump(clock, 0)).toBe(0);
    expect(pump(clock, TICK_MS)).toBe(1);
  });

  it('hash po skoku se rovná referenčnímu běhu o témž počtu tiků', () => {
    const woken = createWorld();
    step(woken, pump(woken.clock, 30_000));

    const reference = createWorld();
    step(reference, MAX_CATCHUP_TICKS);

    expect(woken.clock.tick).toBe(MAX_CATCHUP_TICKS);
    expect(hashHex(woken.state)).toBe(hashHex(reference.state));
  });

  it('couvnutí systémových hodin svět neposune', () => {
    const world = createWorld();
    step(world, pump(world.clock, 1000));
    const before = hashHex(world.state);

    expect(pump(world.clock, -5000)).toBe(0);
    expect(world.clock.accumulatorMs).toBe(0);
    expect(hashHex(world.state)).toBe(before);
  });
});

describe('throttling timerů na pozadí', () => {
  it('sekundový throttling se dožene celý, nic se nezahodí', () => {
    const throttled = createWorld();

    // Záložka na pozadí dostává timery zhruba jednou za sekundu. To je 20 tiků
    // na pumpnutí — pod stropem, takže se to musí dohnat beze ztráty.
    for (let i = 0; i < 30; i += 1) {
      const due = pump(throttled.clock, 1000);
      expect(due).toBe(20);
      step(throttled, due);
    }

    expect(throttled.clock.droppedTicks).toBe(0);

    const reference = createWorld();
    step(reference, 600);

    expect(throttled.clock.tick).toBe(600);
    expect(hashHex(throttled.state)).toBe(hashHex(reference.state));
  });

  it('rozdělení téhož nástěnného času na jinak velké kusy nemění výsledek', () => {
    const coarse = createWorld();
    step(coarse, pump(coarse.clock, 1000));

    const fine = createWorld();
    for (let i = 0; i < 100; i += 1) {
      step(fine, pump(fine.clock, 10));
    }

    expect(fine.clock.tick).toBe(coarse.clock.tick);
    expect(hashHex(fine.state)).toBe(hashHex(coarse.state));
  });
});
