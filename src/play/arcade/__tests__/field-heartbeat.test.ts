/**
 * Tep pole (P47A T9): ve `genre.v4` přežití a quest v prostoru nemají ve vyhraném běhu robota intermediate mezeru
 * bez události delší než 3 s. Po `heartbeatAt` tikách ticha (2,5 s v úvodu, ke konci kratší) přijde mince na
 * nejbližším volném místě vstupu; s plnou plochou tep odvolá minci nejdál od hráče. Sběr a útěk s věcmi tep nemají
 * (strážci hlídají minci jako věc, vlna věcí na ni čeká – README „Rozhodnutí“). Quest v prostoru má cíle a kameny
 * stažené ke středu (`FIELD.questReach`). Uložené hry (`genre.v3`) tep nemají.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeWorld, BODY, BODY_STRIDE, FLAG, HEADER, ROLE, bodyBase, nativeRule } from '../contract';
import { instantiate } from '../kernel';
import { loadRapier } from '../physics/world';
import { PACING, type PacingRuleParams, TENSION_CURVE, heartbeatAt, pacingRule } from '../pieces/pacing';
import { FIELD, FINALE_GENRE_VERSION, HEARTBEAT_COIN } from '../pieces/pacing-parts';
import { QUEST } from '../pieces/quest';
import type { WaveParams } from '../pieces/waves';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

/** Buňky s tepem; sběr a útěk s věcmi jen hlídáme, že tep nemají. */
const CELLS = ['arena.escape', 'quest.spatial'] as const;
const ITEM_CELLS = ['arena.collect', 'arena.escape+collect'] as const;
const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
/** Cíl AC: žádná mezera bez události delší než 3 s. */
const MAX_GAP_S = 3;

const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));
const storedV3 = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v3' } });

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const pacingOf = (world: ArcadeWorld): PacingRuleParams => nativeRule(world.rules, 'pacing')!.params as PacingRuleParams;
const fire = (state: Int32Array, params: PacingRuleParams): readonly ArcadeEffect[] =>
  pacingRule.fire({ state, player: state[HEADER.player] as number, other: -1, source: -1 } as never, params);

beforeAll(async () => {
  await loadRapier();
});

describe('field heartbeat (genre.v4)', () => {
  it('no won intermediate run of survival or the spatial quest has a gap without an event over 3 s (10 seeds × 2 cells)', () => {
    const failures: string[] = [];
    for (const id of CELLS) {
      const spec = cellSpec(id);
      expect(spec.genre?.compilerVersion, id).toBe(FINALE_GENRE_VERSION);
      let wins = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const trace = traceRun(world, runBot(world, undefined, { profile: 'intermediate' }).inputs);
        if (trace.outcome !== 'won') continue;
        wins += 1;
        const gap = funMetrics(trace).longestGapS;
        if (gap > MAX_GAP_S) failures.push(`${id}#${seed}: ${gap} s`);
      }
      // Bez výher by test nic netvrdil: pásmo intermediate je ≥ 0,8.
      expect(wins, id).toBeGreaterThanOrEqual(8);
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it('the beat is at most 2.5 s in the intro and only gets shorter towards the finale', () => {
    const beats = TENSION_CURVE.map(([at]) => heartbeatAt(PACING.heartbeat, at));
    expect(beats[0]).toBe(PACING.heartbeat);
    expect(PACING.heartbeat).toBeLessThanOrEqual(2.5 * ARCADE_HZ);
    for (let k = 1; k < beats.length; k += 1) expect(beats[k]).toBeLessThanOrEqual(beats[k - 1] as number);
    expect(beats.at(-1)).toBeLessThan(beats[0] as number);
  });

  it('a quiet field gets a coin at the nearest free entry spot; a full field recalls the farthest coin', () => {
    const world = worldOf(cellSpec('arena.escape'), 1);
    const params = pacingOf(world);
    const pulse = params.pulse!;
    expect(pulse.beat).toBe(PACING.heartbeat);
    const state = instantiate(world);
    const player = state[HEADER.player] as number;
    const t = bodyBase(pulse.template);
    expect([state[t + BODY.w], state[t + BODY.d]]).toEqual([HEARTBEAT_COIN.w, HEARTBEAT_COIN.d]);
    const tick = 600;
    state[HEADER.tick] = tick;
    const beat = heartbeatAt(pulse.beat, state[bodyBase(params.keeper) + BODY.aux0] as number);
    const coinsIn = (effects: readonly ArcadeEffect[]): ArcadeEffect[] => effects.filter((effect) => effect.kind === 'spawn' && effect.template === pulse.template);
    // Událost před méně než `beat` tiky: tep mlčí.
    state[bodyBase(pulse.keeper) + BODY.x] = tick - beat + 1;
    expect(coinsIn(fire(state, params))).toEqual([]);
    // Ticho `beat` tiků: mince na místě vstupu nejblíž hráči.
    state[bodyBase(pulse.keeper) + BODY.x] = tick - beat;
    const [coin] = coinsIn(fire(state, params));
    const p = bodyBase(player);
    const spots = Array.from({ length: params.spots.length / 2 }, (_, k) => [params.spots[2 * k] as number, params.spots[2 * k + 1] as number] as const);
    const distance = ([x, z]: readonly [number, number]): number => (x - (state[p + BODY.x] as number)) ** 2 + (z - (state[p + BODY.z] as number)) ** 2;
    const nearest = [...spots].sort((a, b) => distance(a) - distance(b))[0]!;
    expect(coin).toMatchObject({ kind: 'spawn', x: nearest[0], z: nearest[1] });
    // Plná plocha: tři živé mince tepu – žádná nová, odejde ta nejdál od hráče.
    const slot = state[HEADER.spawnBase] as number;
    const placed = [[2000, 0], [9000, 9000], [0, -4000]] as const;
    for (const [k, [x, z]] of placed.entries()) {
      const at = bodyBase(slot + k);
      state.copyWithin(at, t, t + BODY_STRIDE);
      state[at + BODY.flags] = (state[at + BODY.flags] as number) | FLAG.alive;
      state[at + BODY.x] = (state[p + BODY.x] as number) + x;
      state[at + BODY.z] = (state[p + BODY.z] as number) + z;
    }
    state[HEADER.bodyCount] = Math.max(state[HEADER.bodyCount] as number, slot + placed.length);
    const full = fire(state, params);
    expect(coinsIn(full)).toEqual([]);
    expect(full.filter((effect) => effect.kind === 'despawn')).toEqual([{ kind: 'despawn', body: slot + 1 }]);
  });

  it('v4 quest targets of every round lie within questReach of the centre (≤ 2.4 s apart); stored v3 keeps the generator ring', () => {
    let wider = 0;
    for (const seed of SEEDS) {
      const radii = (world: ArcadeWorld): number[] => {
        const waves = nativeRule(world.rules, 'arena_waves')!.params as WaveParams;
        const later = waves.waves.flatMap((wave) => {
          const items = wave.items ?? [];
          return Array.from({ length: items.length / 2 }, (_, k) => Math.hypot(items[2 * k] as number, items[2 * k + 1] as number));
        });
        // Cíle prvního kola = živé cíle na startu (předloha cíle kol je mrtvá).
        const state = instantiate(world);
        const first = Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => bodyBase(body))
          .filter((base) => state[base + BODY.role] === ROLE.target && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0)
          .map((base) => Math.hypot(state[base + BODY.x] as number, state[base + BODY.z] as number));
        expect(first.length).toBeGreaterThan(0);
        return [...first, ...later];
      };
      expect(Math.max(...radii(worldOf(cellSpec('quest.spatial'), seed))), `seed ${seed}`).toBeLessThanOrEqual(FIELD.questReach);
      if (Math.max(...radii(worldOf(storedV3(cellSpec('quest.spatial')), seed))) > FIELD.questReach) wider += 1;
    }
    expect(2 * FIELD.questReach).toBeLessThanOrEqual(2.5 * ARCADE_HZ * 150);
    expect(FIELD.questReach).toBeLessThan(QUEST.targetRing[1]);
    expect(wider).toBeGreaterThan(0);
  });

  it('stored genre.v3 field games and v4 item games have no heartbeat', () => {
    const pulseOf = (world: ArcadeWorld): unknown => (nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined)?.pulse;
    for (const id of [...CELLS, ...ITEM_CELLS]) {
      for (const seed of SEEDS.slice(0, 3)) {
        const stored = worldOf(storedV3(cellSpec(id)), seed);
        expect(pulseOf(stored), `${id}#${seed}`).toBeUndefined();
        expect(JSON.stringify([stored.control, stored.bot]).includes('"pulse"'), `${id}#${seed}`).toBe(false);
        const current = worldOf(cellSpec(id), seed);
        if ((ITEM_CELLS as readonly string[]).includes(id)) expect(JSON.stringify([current.rules, current.control, current.bot]).includes('"pulse"'), `${id}#${seed}`).toBe(false);
        else expect(pulseOf(current), `${id}#${seed}`).toBeDefined();
      }
    }
  });
});
