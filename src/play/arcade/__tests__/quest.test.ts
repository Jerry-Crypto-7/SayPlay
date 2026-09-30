/**
 * Úkol (P32G T2): generátory `quest_spatial` a `quest_station` a jejich robot.
 *
 * Co by vypadalo dobře a přitom bylo špatně: úkol, který robot vyhraje jen
 * u pár semínek, pronásledovatel, který nečinného hráče chytí hned po startu
 * (nebo ho nehoní vůbec, a „férový start“ pak platí zadarmo), a palačinka,
 * která se obrátí i mimo okno připravenosti. Hlídá to tenhle test na 200
 * semínkách.
 */

import { describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';

import { type ArcadeEffect, type ArcadeWorld, BODY, BUTTON, HEADER, NO_INPUT, ROLE, UNIT, bodyBase, targetStateOf } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { QUEST, type QuestSpatialParams, type QuestStationParams, checkQuestLevel, questSpatial, questStation } from '../pieces/quest';
import { runBot, verifyArcade } from '../verify';

/** 200 semínek z `pure-rand` (přes `createCompileRng`, jedinou povolenou cestu). */
const SEEDS = (() => {
  const rng = createCompileRng(20_260_929);
  return Array.from({ length: 200 }, () => rng.int(1, 2 ** 31 - 2));
})();

function build(seed: number, parts: ReturnType<typeof questSpatial.parts>, name: string): ArcadeWorld {
  if (parts.issues !== undefined && parts.issues.length > 0) throw new Error(`${name}/${seed}: ${parts.issues.join('; ')}`);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(`${name}/${seed}: ${built.issues.join('; ')}`);
  return built.world;
}

const spatialWorld = (seed: number, raw: Partial<QuestSpatialParams> = {}): ArcadeWorld => build(seed, questSpatial.parts(seed, questSpatial.params.parse(raw), undefined), 'spatial');
const stationWorld = (seed: number, raw: Partial<QuestStationParams> = {}): ArcadeWorld => build(seed, questStation.parts(seed, questStation.params.parse(raw), undefined), 'station');

/** Stanoviště nemá náhodné rozmístění: semínko losuje jeho parametry (počet, držení, okno). */
function stationParamsOf(seed: number): Partial<QuestStationParams> {
  const rng = createCompileRng(seed);
  return { count: rng.int(1, 3), states: rng.pick([2, 3] as const), hold: rng.int(0, 60), after: rng.int(30, 150), window: rng.int(30, 90) };
}

/** Kolik semínek robot vyhraje; prohry vrátí pro zprávu. */
function winRate(worldOf: (seed: number) => ArcadeWorld) {
  const misses: string[] = [];
  for (const seed of SEEDS) {
    const run = runBot(worldOf(seed));
    if (run.outcome !== 'won') misses.push(`${seed}: ${run.outcome} at ${run.tick}`);
  }
  return { wins: SEEDS.length - misses.length, misses };
}

const WIN_SHARE = Math.ceil(0.95 * SEEDS.length);

describe('quest – the bot finishes both generators', () => {
  it('spatial without chasers: the bot wins at least 95 % of 200 seeds', () => {
    const { wins, misses } = winRate((seed) => spatialWorld(seed, { count: 5, states: 3 }));
    expect(wins, misses.join('\n')).toBeGreaterThanOrEqual(WIN_SHARE);
  });

  it('spatial with chasers: the bot wins at least 95 % of 200 seeds', () => {
    const { wins, misses } = winRate((seed) => spatialWorld(seed, { count: 5, chasers: 2 }));
    expect(wins, misses.join('\n')).toBeGreaterThanOrEqual(WIN_SHARE);
  });

  it('station: the bot wins at least 95 % of 200 seeds', () => {
    const { wins, misses } = winRate((seed) => stationWorld(seed, stationParamsOf(seed)));
    expect(wins, misses.join('\n')).toBeGreaterThanOrEqual(WIN_SHARE);
  });

  it('a won quest passes verification: replay equal and the idle player does not win', () => {
    for (const world of [spatialWorld(SEEDS[0] as number, { chasers: 1 }), stationWorld(1)]) {
      const verdict = verifyArcade(world);
      expect(verdict.failures).toEqual([]);
      expect(verdict.idle.outcome).not.toBe('won');
    }
  });
});

describe('quest – spatial levels are fair', () => {
  it('every level from 200 seeds places all 1–8 targets and 0–4 chasers and passes checkQuestLevel', () => {
    for (const seed of SEEDS) {
      const count = 1 + (seed % 8);
      const chasers = seed % 5;
      const params = questSpatial.params.parse({ count, chasers, rocks: 6 });
      const parts = questSpatial.parts(seed, params, undefined);
      expect(parts.issues ?? [], `seed ${seed}`).toEqual([]);
      expect(checkQuestLevel(parts.level, params.chaserSpeed), `seed ${seed}`).toEqual([]);
      expect(parts.level.bodies.filter((body) => body.role === 'target')).toHaveLength(count);
      expect(parts.level.bodies.filter((body) => body.role === 'chaser')).toHaveLength(chasers);
    }
  });

  it('checkQuestLevel refuses a chaser in front of or next to the player and chasers without the start grace', () => {
    const parts = questSpatial.parts(1, questSpatial.params.parse({ chasers: 1 }), undefined);
    const level = parts.level;
    const moved = (z: number) => ({ ...level, bodies: level.bodies.map((body) => (body.role === 'chaser' ? { ...body, x: 0, z } : body)) });
    expect(checkQuestLevel(moved(12 * UNIT), QUEST.chaserSpeed).join(' ')).toMatch(/in front of the player/);
    expect(checkQuestLevel(moved(-3 * UNIT), QUEST.chaserSpeed).join(' ')).toMatch(/needs/);
    expect(checkQuestLevel({ ...level, counters: {} }, QUEST.chaserSpeed)).toContain('chasers without the 2 s start grace');
  });

  it('chasers catch an idle player, but never before 4 s', () => {
    let caught = 0;
    for (const seed of SEEDS) {
      const idle = replay(spatialWorld(seed, { chasers: 1 + (seed % 4) }), [], ARCADE_LIBRARY);
      if (idle.outcome !== 'lost') continue;
      caught += 1;
      expect(idle.tick, `seed ${seed}`).toBeGreaterThanOrEqual(QUEST.idleContactTicks);
    }
    // Pronásledovatel, který nehoní, by splnil „nejdřív za 4 s“ zadarmo.
    expect(caught).toBeGreaterThanOrEqual(WIN_SHARE);
  });
});

describe('quest – chasers slow down while the player holds Use (G-R1)', () => {
  it('a spatial quest halves its chasers while Use is held, and not otherwise', () => {
    const topSpeed = (seed: number, buttons: number): number => {
      const world = spatialWorld(seed, { chasers: 2 });
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      let top = 0;
      for (let t = 0; t < 4 * 60 && state[HEADER.runState] === 0; t += 1) {
        step(state, { buttons, axis: 0 }, program);
        if (t < 150) continue;
        for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
          if (state[bodyBase(i) + BODY.role] === ROLE.chaser) top = Math.max(top, Math.hypot(state[bodyBase(i) + BODY.vx] as number, state[bodyBase(i) + BODY.vz] as number));
        }
      }
      return top;
    };
    const half = Math.trunc(QUEST.chaserSpeed / 2);
    for (const seed of SEEDS.slice(0, 10)) {
      expect(topSpeed(seed, BUTTON.INTERACT), `seed ${seed}: holding Use`).toBeLessThanOrEqual(half);
      expect(topSpeed(seed, 0), `seed ${seed}: not holding Use`).toBeGreaterThan(half);
    }
  });
});

describe('quest – station readiness window', () => {
  const USE = BUTTON.INTERACT;

  /** Jedno stanoviště přímo před hrdinou: nalít 30 tiků, pak 90 tiků se peče a 60 je zlatá. */
  function pancake() {
    const params = questStation.params.parse({ count: 1, states: 3, hold: 30, after: 90, window: 60 });
    const world = stationWorld(1, params);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const target = questStation.generate(1, params).bodies.findIndex((body) => body.role === 'target');
    let tick = 0;
    const effects: ArcadeEffect[] = [];
    /** Drží nebo pouští až do tiku `until` (výlučně). */
    const until = (end: number, buttons: number): void => {
      for (; tick < end; tick += 1) effects.push(...step(state, buttons === 0 ? NO_INPUT : { buttons, axis: 0 }, program));
    };
    return { state, target, until, effects, now: () => tick };
  }

  it('flipping before the window or after it closed does not move the state; inside the window it does', () => {
    const g = pancake();
    // Nalít: 30 tiků držení posune stav 0 → 1.
    g.until(30, USE);
    expect(targetStateOf(g.state, g.target)).toBe(1);
    const poured = g.effects.findIndex((effect) => effect.kind === 'stateChange');
    expect(poured).toBeGreaterThanOrEqual(0);
    const at = g.now();
    // Obrátit hned (peče se): celé držení i puštění uvnitř 90 tiků.
    g.until(at + 5, 0);
    g.until(at + 45, USE);
    g.until(at + 60, 0);
    expect(targetStateOf(g.state, g.target)).toBe(1);
    // Okno (90..150) nechat uplynout, obrátit, když se zase peče (150..240).
    g.until(at + 165, 0);
    g.until(at + 205, USE);
    g.until(at + 215, 0);
    expect(targetStateOf(g.state, g.target)).toBe(1);
    // Držení nachystané předem obrátí, jakmile se otevře další okno (240..300): zlatá a výhra.
    g.until(at + 285, USE);
    expect(targetStateOf(g.state, g.target)).toBe(2);
    expect(g.effects.filter((effect) => effect.kind === 'stateChange')).toHaveLength(2);
    expect(g.effects.some((effect) => effect.kind === 'win')).toBe(true);
  });
});
