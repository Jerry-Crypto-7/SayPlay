import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '../../spec';
import flapFixture from '../__fixtures__/flap.json';
import { arcadeWorldOf } from '../compile';
import { BODY, BUTTON, COUNTER, FLAG, HEADER, bodyBase } from '../contract';
import { instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { RHYTHM, RHYTHM_DENSITIES, type RhythmLevelParams, beatMap, checkRhythmLevel, rhythmLevel, rhythmTicks } from '../pieces/rhythm';
import { verifyArcade } from '../verify';

const params = (extra: Partial<RhythmLevelParams> = {}): RhythmLevelParams => rhythmLevel.params.parse(extra);

// Spec rytmu na šabloně poletování – kompilátor čte jen `control`, parametry a mechaniky.
const rhythmSpec = (controlParams: Record<string, unknown>, health?: number): GameSpecV1 => ({
  ...(flapFixture as GameSpecV1),
  control: 'rhythm',
  controlParams,
  mechanics: [...(flapFixture as GameSpecV1).mechanics, ...(health === undefined ? [] : [{ id: 'health' as const, params: { max: health } }])],
});

function worldOf(controlParams: Record<string, unknown>, seed = 1, health?: number) {
  const made = arcadeWorldOf(rhythmSpec(controlParams, health), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('rytmus – beat mapa a generátor', () => {
  it('stejné semínko = stejná beat mapa, jiné semínko jinou; noty dorazí na tik beatu', () => {
    for (const density of RHYTHM_DENSITIES) {
      expect(beatMap(5, params({ density }))).toEqual(beatMap(5, params({ density })));
      const level = rhythmLevel.generate(5, params({ density }));
      expect(rhythmTicks(level)).toEqual(beatMap(5, params({ density })));
    }
    expect(beatMap(5, params({ density: 'sparse' }))).not.toEqual(beatMap(6, params({ density: 'sparse' })));
  });

  it('30 semínek × 3 hustoty × 3 tempa splní invarianty; hustota přidá noty', () => {
    const totals: Record<string, number> = {};
    for (const density of RHYTHM_DENSITIES) {
      for (const bpm of [80, 120, 160]) {
        for (let seed = 1; seed <= 30; seed += 1) {
          const p = params({ density, bpm });
          const level = rhythmLevel.generate(seed, p);
          expect(checkRhythmLevel(level, p.window), `${density}/${bpm}/${seed}`).toEqual([]);
          totals[density] = (totals[density] ?? 0) + level.bodies.length - 1;
        }
      }
    }
    expect(totals.sparse).toBeLessThan(totals.normal as number);
    expect(totals.normal).toBeLessThan(totals.dense as number);
  });

  it('kontrola odhalí noty blíž než dvě okna', () => {
    const level = rhythmLevel.generate(1, params());
    const [, first, second] = level.bodies;
    const squeezed = { ...level, bodies: level.bodies.map((b) => (b === second ? { ...b, z: (first as typeof b).z + 10 * RHYTHM.noteSpeed } : b)) };
    expect(checkRhythmLevel(squeezed, RHYTHM.window).join()).toMatch(/closer than two ±8-tick windows/);
  });
});

describe('rytmus – ovládání a pravidla', () => {
  it('ťuk v tiku beatu = trefa za 3 body a kombo; ťuk bez noty = minutí', () => {
    const w = worldOf({}, 2, 3);
    const [first] = beatMap(2, params());
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    for (let tick = 0; tick < (first as number); tick += 1) step(state, { buttons: 0, axis: 0 }, program);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(3);
    expect(state[bodyBase(0) + BODY.aux1]).toBe(1);
    expect((state[bodyBase(1) + BODY.flags] as number) & FLAG.alive).toBe(0);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.health]).toBe(2);
    expect(state[bodyBase(0) + BODY.aux1]).toBe(0);
  });

  it('přejetá nota je minutí: bez životů prohra hned u první', () => {
    const w = worldOf({}, 3);
    const [first] = beatMap(3, params());
    const idle = replay(w, [], ARCADE_LIBRARY);
    expect(idle.outcome).toBe('lost');
    // Minutí padne v kroku tiku beat + okno + 1; `tick` po něm ukazuje o jeden dál.
    expect(idle.tick).toBe((first as number) + RHYTHM.window + 2);
  });

  it('životů je nejvýš čtvrtina not: nečinný hráč písničku nepřežije', () => {
    const w = worldOf({ beats: 24, density: 'sparse' }, 4, 99);
    const notes = w.initial[HEADER.bodyCount] as number;
    expect(w.initial[HEADER.counters + COUNTER.health]).toBe(Math.floor((notes - 1) / 4));
    expect(replay(w, [], ARCADE_LIBRARY).outcome).toBe('lost');
  });

  it('spec pustí tempo, hustotu a délku, cizí parametr odmítne', () => {
    expect(readGameSpec(rhythmSpec({ bpm: 140, density: 'dense', beats: 64 })).ok).toBe(true);
    expect(readGameSpec(rhythmSpec({ bpm: 300 })).ok).toBe(false);
    expect(readGameSpec(rhythmSpec({ window: 3 })).ok).toBe(false);
  });
});

describe('rytmus – robot a ověření', () => {
  it('robot se zpožděním 8 tiků vyhraje 30 semínek × 3 hustoty, nečinný hráč prohraje, přehrání sedí', () => {
    for (const density of RHYTHM_DENSITIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(worldOf({ density, bpm: 80 + ((seed * 7) % 81) }, seed, seed % 2 === 0 ? 3 : undefined));
        expect(verdict.failures, `${density}/${seed}`).toEqual([]);
        expect(verdict.bot.outcome).toBe('won');
        expect(verdict.idle.outcome).toBe('lost');
      }
    }
  });
});
