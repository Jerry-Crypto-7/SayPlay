/**
 * Rozmístění power-upů (P46C T2) na základních hrách žánrů z golden sady: nová verze
 * žánru (`genre.v3`) proti uložené (`genre.v2`) na týchž semínkách. Power-up leží, kam
 * hráč dosáhne, robot ho sebere a obtížnost zůstane v pásmu.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '@/play/spec';
import { canonicalHash } from '@/ir/worlddoc';

import { baseControlOf } from '../../addons';
import { arcadeWorldOf } from '../../compile';
import { ARCADE_LIMITS, type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, underlyingRule } from '../../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { ARENA } from '../../pieces/arena';
import { RUNNER } from '../../pieces/runner';
import { centerAt, courseOf } from '../../pieces/steer';
import { runBot, verifyArcade } from '../../verify';
import { POWERUP_GENRE_VERSION } from '../placement';
import golden from '../../../../../evals/play/p41/golden/genres.json';

const VARIANTS = ['runner.default/base', 'platformer.default/base', 'voyage.race/base', 'arena.escape/base', 'arena.collect/base'] as const;
const SEEDS = Array.from({ length: 10 }, (_v, i) => i + 1);

const specOf = (id: string, version: string): GameSpecV1 => {
  const found = (golden.variants as unknown as { id: string; spec: GameSpecV1 }[]).find((variant) => variant.id === id);
  if (found === undefined) throw new Error(`no golden variant ${id}`);
  const read = readGameSpec({ ...found.spec, genre: { ...found.spec.genre, compilerVersion: version } });
  if (!read.ok) throw new Error(`${id}: ${JSON.stringify(read)}`);
  return read.value;
};

function worldOf(id: string, version: string, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(specOf(id, version), seed);
  if (!made.ok) throw new Error(`${id} seed ${seed}: ${made.issues.join('; ')}`);
  return made.world;
}

const powerupsOf = (state: Int32Array): number[] => {
  const found: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) if (state[bodyBase(i) + BODY.role] === ROLE.powerup) found.push(i);
  return found;
};

/** Kolik power-upů robot profilu `profile` sebral (tělesa, která na konci jeho běhu nežijí). */
function taken(world: ArcadeWorld, profile: 'novice' | 'intermediate'): { readonly picked: number; readonly won: boolean } {
  const run = runBot(world, undefined, { profile });
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < run.inputs.length && (run.inputs[next] as { tick: number }).tick < tick) next += 1;
    const event = run.inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  const picked = powerupsOf(state).filter((body) => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0).length;
  return { picked, won: run.outcome === 'won' };
}

const unproved = (world: ArcadeWorld): string[] => verifyArcade(world).failures.filter((failure) => failure.startsWith('verbs_proved'));

/** Leží power-up tam, kam hráč žánru dosáhne? */
function reachable(id: string, world: ArcadeWorld, state: Int32Array, body: number): boolean {
  const at = (slot: keyof typeof BODY, i = body): number => state[bodyBase(i) + BODY[slot]] as number;
  if (id.startsWith('runner')) return [-1, 0, 1].some((lane) => at('x') === lane * RUNNER.laneWidth) && at('z') > 0 && at('z') < world.length;
  if (id.startsWith('arena')) {
    const half = (baseControlOf(world.control).params as { half?: number }).half ?? ARENA.half;
    return Math.abs(at('x')) < half && Math.abs(at('z')) < half;
  }
  // Řízení: na trati před cílem; že leží na ose silnice, hlídá test níž.
  if (id.startsWith('voyage')) return at('z') > 0 && at('z') < world.length;
  // Skákačka: power-up stojí na horní hraně plošiny.
  for (let i = 1; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (state[bodyBase(i) + BODY.role] !== ROLE.platform) continue;
    if (at('y', i) + at('h', i) === at('y') && at('z', i) === at('z') && at('x', i) === at('x')) return true;
  }
  return false;
}

describe('power-up placement', () => {
  it.each(VARIANTS)('%s places 2-4 reachable power-ups only in the new genre version', (id) => {
    for (const seed of SEEDS) {
      const world = worldOf(id, POWERUP_GENRE_VERSION, seed);
      const state = instantiate(world);
      const bodies = powerupsOf(state);
      expect(bodies.length, `${id} seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(bodies.length, `${id} seed ${seed}`).toBeLessThanOrEqual(4);
      for (const body of bodies) expect(reachable(id, world, state, body), `${id} seed ${seed} body ${body}`).toBe(true);
      const old = worldOf(id, 'genre.v2', seed);
      expect(powerupsOf(instantiate(old)), `${id} seed ${seed} genre.v2`).toHaveLength(0);
      expect(old.rules.map(underlyingRule).some((rule) => rule.params.powerup !== undefined)).toBe(false);
    }
  });

  it('keeps a stored genre.v2 world byte for byte', () => {
    const a = worldOf('runner.default/base', 'genre.v2', 1);
    const b = worldOf('runner.default/base', 'genre.v2', 1);
    expect(canonicalHash(b)).toBe(canonicalHash(a));
  });

  it('puts the steering pads on the course axis', () => {
    for (const seed of SEEDS) {
      const world = worldOf('voyage.race/base', POWERUP_GENRE_VERSION, seed);
      const state = instantiate(world);
      const bodies: { role: string; x: number; z: number; w: number; d: number; y: number; h: number; solid: boolean; kind: string }[] = [];
      for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
        const base = bodyBase(i);
        const role = (Object.keys(ROLE) as (keyof typeof ROLE)[]).find((name) => ROLE[name] === state[base + BODY.role]) ?? 'thing';
        bodies.push({ role, x: state[base + BODY.x] as number, y: state[base + BODY.y] as number, z: state[base + BODY.z] as number, w: state[base + BODY.w] as number, h: state[base + BODY.h] as number, d: state[base + BODY.d] as number, solid: ((state[base + BODY.flags] as number) & FLAG.solid) !== 0, kind: world.kinds[state[base + BODY.kind] as number] as string });
      }
      const course = courseOf({ bodies, length: world.length } as never);
      for (const body of powerupsOf(state)) expect(state[bodyBase(body) + BODY.x], `seed ${seed}`).toBe(centerAt(course, state[bodyBase(body) + BODY.z] as number));
    }
  });
});

describe('bots take power-ups and the difficulty stays in band', () => {
  it.each(VARIANTS)('%s', (id) => {
    let picked = 0;
    const rates = { novice: 0, intermediate: 0, baseNovice: 0, baseIntermediate: 0 };
    for (const seed of SEEDS) {
      const world = worldOf(id, POWERUP_GENRE_VERSION, seed);
      const intermediate = taken(world, 'intermediate');
      if (intermediate.picked >= 1) picked += 1;
      if (intermediate.won) rates.intermediate += 1;
      if (taken(world, 'novice').won) rates.novice += 1;
      const old = worldOf(id, 'genre.v2', seed);
      if (runBot(old, undefined, { profile: 'intermediate' }).outcome === 'won') rates.baseIntermediate += 1;
      if (runBot(old, undefined, { profile: 'novice' }).outcome === 'won') rates.baseNovice += 1;
      // Power-up nic neslibuje: publikační brána nesmí chtít důkaz slovesa, který hra bez něj nechtěla (štít).
      expect(unproved(world), `${id} seed ${seed}`).toEqual(unproved(old));
    }
    const n = SEEDS.length;
    expect(picked / n, `${id}: games where the intermediate bot took a power-up`).toBeGreaterThanOrEqual(0.8);
    expect(rates.intermediate / n, `${id}: intermediate, base ${rates.baseIntermediate / n}`).toBeGreaterThanOrEqual(Math.min(0.8, rates.baseIntermediate / n));
    expect(rates.novice / n, `${id}: novice, base ${rates.baseNovice / n}`).toBeLessThanOrEqual(Math.max(0.7, rates.baseNovice / n));
    expect(rates.novice / n, `${id}: novice, base ${rates.baseNovice / n}`).toBeGreaterThanOrEqual(Math.min(0.3, rates.baseNovice / n));
  }, 300_000);
});
