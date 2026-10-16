/**
 * Terč-boss hodu (P47A T7, jen `genre.v4`): bonusový terč posledního kola je boss – tělo role `enemy`
 * (`bossBody` bonusového terče: 9/4 rozměrů, `kind` `boss`) s HP `THROW_BOSS.hp`, které se kýve stranou
 * jako bonusový terč (`THROW_SWING`, rychlost posledního kola z křivky). Zásah míčem mu ubere 1 HP efektem
 * `hit` (`shot_hit.tough`), poslední HP ho sebere; kolo, a s ním výhru `throw_rounds`, uzavře až jeho pád.
 * Poslední kolo má hodů o `hp − 1` víc a navíc rezervu `THROW_BOSS.reserve`, aby náboje nebyly útes.
 * Uložené `genre.v3` hody staví bajtově týž svět a robot hraje týž hash.
 *
 * Co by vypadalo dobře a bylo špatně: boss, který padne prvním zásahem (HP chybí – telemetrie by ho
 * neuznala); poslední kolo bez hodů navíc (robot by na bosse neměl a výhra by visela na štěstí);
 * boss už v dřívějším kole nebo jiná kola než v `genre.v3` (rozvržení kol se nesmí hnout).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, FLAG, HEADER, type PieceRef, ROLE, RUN_STATE, bodyBase, bodyHp, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { play } from '../pieces/behaviours/__tests__/harness';
import { TENSION_CURVE, intensityAt } from '../pieces/pacing';
import { THROW_BOSS, THROW_SWING, type ThrowRoundsParams, swingSpeed } from '../pieces/throw';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BAND_SEEDS = Array.from({ length: 20 }, (_, k) => k + 1);
const cellSpec = (): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === 'throw.default')!));
const draft = (text: string): GameSpecV1 => draftGameSpecWithMeta(text, 1).spec;
const withVersion = (spec: GameSpecV1, version: string): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: version } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const ruleOf = (world: ArcadeWorld, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const roundsOf = (world: ArcadeWorld): ThrowRoundsParams => ruleOf(world, 'throw_rounds')!.params as unknown as ThrowRoundsParams;
const kindOf = (world: ArcadeWorld, state: Int32Array, body: number): string | undefined => world.kinds[state[bodyBase(body) + BODY.kind] as number];
const read = (state: Int32Array, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;

/** Hod: buňka P41 a věty dev sady P47A (t01–t03). */
const THROW_GAMES: readonly [string, () => GameSpecV1][] = [
  ['cell throw.default', cellSpec],
  ['t01 snowballs', () => draft('Throw snowballs at targets in a winter park')],
  ['t02 darts', () => draft('Toss darts at balloons in a carnival')],
  ['t03 tomatoes', () => draft('Throw tomatoes at the villain in a medieval town square')],
];

/** Uložené `genre.v3` hody nad `fda40148` (= `abe38f04` pro hod): sha256 světa a hash robota intermediate. */
const STORED_PINS: readonly { readonly seed: number; readonly world: string; readonly bot: string }[] = [
  { seed: 1, world: '992b9bf6b62a1d62900c91badb8b5b65358660ba66d8bcb003053b428d2f2138', bot: 'c645357c' },
  { seed: 2, world: '8cfdb51f2d5ec760f14804094cfbba8e61f5688ee010eec246c8256f57813410', bot: '363f4f1e' },
];

describe('throw game ends with a boss target (P47A T7, genre.v4)', () => {
  for (const [name, specOf] of THROW_GAMES) {
    it(`${name}: the last round's swinging target is a 3 HP enemy boss, the rounds are the genre.v3 rounds, the last round has the boss throws and the reserve`, () => {
      const spec = specOf();
      expect(spec.genre?.compilerVersion).toBe('genre.v4');
      for (const seed of SEEDS.slice(0, 4)) {
        const world = worldOf(spec, seed);
        const stored = worldOf(withVersion(spec, 'genre.v3'), seed);
        const rounds = roundsOf(world).rounds;
        const before = roundsOf(stored).rounds;
        const start = instantiate(world);
        const last = rounds.at(-1)!;
        const boss = last.swing![0];
        // Tělo bosse: nepřítel, `bossBody` bonusového terče (9/4 rozměrů), kýve se, HP 3.
        expect(read(start, boss, 'role'), `${name} seed ${seed}: role`).toBe(ROLE.enemy);
        expect(kindOf(world, start, boss)).toBe('boss');
        expect(bodyHp(start, boss), `${name} seed ${seed}: HP`).toBe(THROW_BOSS.hp);
        expect(THROW_BOSS.hp).toBe(3);
        for (const slot of ['w', 'h', 'd'] as const) expect(read(start, boss, slot)).toBe(Math.trunc((THROW_SWING.body[slot] * 9) / 4));
        expect((read(start, boss, 'flags') & FLAG.kinematic) !== 0).toBe(true);
        expect(ruleOf(world, 'shot_hit')!.params.tough, `${name} seed ${seed}: shot_hit takes HP from the boss`).toBe(boss);
        expect(ruleOf(stored, 'shot_hit')!.params.tough).toBeUndefined();
        // Kýve se jako bonusový terč, kterého nahradil: rychlost posledního kola z křivky (nejrychlejší).
        const speeds = rounds.length + 1;
        expect(Math.abs(last.swing![4])).toBe(swingSpeed(intensityAt(Math.floor(((2 * rounds.length + 1) * 500) / speeds), TENSION_CURVE)));
        expect(Math.abs(last.swing![4])).toBe(Math.abs(before.at(-1)!.swing![4]));
        // Kola jako v `genre.v3`: tatáž kola před posledním; poslední kolo bez tří nejvyšších cílů (věž shora).
        expect(rounds.length, `${name} seed ${seed}: rounds`).toBe(before.length);
        rounds.slice(0, -1).forEach((round, index) => {
          expect(round, `${name} seed ${seed} round ${index}`).toEqual(before[index]);
          expect(read(start, round.swing![0], 'role')).toBe(ROLE.target);
        });
        const storedStart = instantiate(stored);
        const decode = (from: ArcadeWorld, state: Int32Array, quads: readonly number[]) =>
          Array.from({ length: quads.length / 4 }, (_, k) => ({ role: read(state, quads[4 * k]!, 'role'), kind: kindOf(from, state, quads[4 * k]!), x: quads[4 * k + 1], y: quads[4 * k + 2], z: quads[4 * k + 3] }));
        const was = decode(stored, storedStart, before.at(-1)!.bodies);
        const targets = was.filter((body) => body.role === ROLE.target);
        const highest = new Set([...targets].sort((a, b) => b.y! - a.y!).slice(0, THROW_BOSS.hp));
        // Opěra stojí pod terčem (podstavec, stejné `z`) nebo 0,7 m za košem (tyč); s odebraným cílem odejde i ona (P47A T10).
        const holds = (support: (typeof was)[number], target: (typeof was)[number]): boolean => support.x === target.x && support.z! - target.z! >= 0 && support.z! - target.z! <= 700;
        const orphan = (body: (typeof was)[number]): boolean => body.role === ROLE.obstacle && [...highest].some((target) => holds(body, target));
        const round = decode(world, start, last.bodies);
        expect(round, `${name} seed ${seed}: the boss round`).toEqual(was.filter((body) => !highest.has(body) && !orphan(body)));
        // Žádná opěra v kole bosse nestojí bez svého cíle.
        for (const support of round.filter((body) => body.role === ROLE.obstacle)) expect(round.some((body) => body.role === ROLE.target && holds(support, body)), `${name} seed ${seed}: ${support.kind} at ${support.z}`).toBe(true);
        // Hody posledního kola: zbylé cíle, tři na bosse, hody navíc kola jako v `genre.v3` a rezerva.
        const spare = before.at(-1)!.throws - targets.length - 1;
        expect(spare).toBeGreaterThanOrEqual(1);
        expect(last.throws, `${name} seed ${seed}: last round throws`).toBe(targets.length - highest.size + THROW_BOSS.hp + spare + THROW_BOSS.reserve);
        expect(THROW_BOSS.reserve).toBeGreaterThan(0);
      }
    });

    it(`${name}: the boss falls on its third hit, the win comes after the fall, telemetry says boss`, () => {
      const spec = specOf();
      let wins = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        if (bot.outcome !== 'won') continue;
        wins += 1;
        const hp: number[] = [];
        let fell = -1;
        let won = -1;
        const isBoss = (state: Int32Array, body: number): boolean => kindOf(world, state, body) === 'boss' && read(state, body, 'role') === ROLE.enemy;
        play(world, bot.inputs, (state, tick, effects: readonly ArcadeEffect[]) => {
          for (const effect of effects) {
            if (effect.kind === 'hit' && isBoss(state, effect.body)) {
              expect(effect.amount).toBe(1);
              hp.push(bodyHp(state, effect.body));
            }
            // Konec kola uvolní slot, do kterého v témže tiku přijde boss: padlý boss je ten, kdo po tiku nežije.
            if (effect.kind === 'despawn' && isBoss(state, effect.body) && (read(state, effect.body, 'flags') & FLAG.alive) === 0) {
              expect(fell, `${name} seed ${seed}: one boss`).toBe(-1);
              fell = tick;
            }
          }
          if (won < 0 && state[HEADER.runState] === RUN_STATE.won) won = tick;
        });
        // HP 3 → 2 → 1 → 0: tři zásahy, pád právě s třetím.
        expect(hp, `${name} seed ${seed}: boss HP after each hit`).toEqual([2, 1, 0]);
        expect(fell, `${name} seed ${seed}: the boss fell`).toBeGreaterThan(0);
        expect(won).toBeGreaterThanOrEqual(fell);
        expect(funMetrics(traceRun(world, bot.inputs)).finale.why, `${name} seed ${seed}: finale`).toBe('boss');
      }
      expect(wins, `${name}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 600_000);
  }

  it('cell throw.default: bands on 20 seeds – intermediate ≥ 0.8 and the boss fell in every win, novice 0.3–0.7', () => {
    const spec = cellSpec();
    let intermediate = 0;
    let novice = 0;
    for (const seed of BAND_SEEDS) {
      const world = worldOf(spec, seed);
      const bot = runBot(world, undefined, { profile: 'intermediate' });
      if (bot.outcome === 'won') {
        intermediate += 1;
        expect(funMetrics(traceRun(world, bot.inputs)).finale.why, `seed ${seed}: boss fell`).toBe('boss');
      }
      if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
    }
    expect(intermediate / BAND_SEEDS.length).toBeGreaterThanOrEqual(0.8);
    expect(novice / BAND_SEEDS.length).toBeGreaterThanOrEqual(0.3);
    expect(novice / BAND_SEEDS.length).toBeLessThanOrEqual(0.7);
  }, 600_000);

  it('a stored genre.v3 throw game has no boss, builds the same world and the bot plays the same hash', () => {
    for (const pin of STORED_PINS) {
      const world = worldOf(withVersion(cellSpec(), 'genre.v3'), pin.seed);
      const start = instantiate(world);
      expect(world.kinds).not.toContain('boss');
      expect(roundsOf(world).rounds.every((round) => round.swing === undefined || read(start, round.swing[0], 'role') === ROLE.target)).toBe(true);
      expect(createHash('sha256').update(JSON.stringify(world)).digest('hex'), `seed ${pin.seed}`).toBe(pin.world);
      const bot = runBot(world, undefined, { profile: 'intermediate' });
      expect(bot.hash, `seed ${pin.seed}`).toBe(pin.bot);
      expect(funMetrics(traceRun(world, bot.inputs)).finale.why).toBeNull();
    }
  });
});
