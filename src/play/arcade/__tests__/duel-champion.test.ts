/**
 * Šampion duelu (P47A T6, jen `genre.v4`): poslední soupeř dostane tělo bosse – předloha `bossBody`
 * (větší, `kind` `boss`) na konci úrovně, ovládání `duel` s parametrem `champion` ji v tiku, kdy padne
 * předposlední soupeř, otiskne do těla soupeře (`DUEL_FOE`) a dá mu HP = `foeHealth`. Každý úder hráče
 * v okně na šampiona je efekt `hit` na to tělo (pravidlo `judge`, `champion`), knockout ho nechá ležet
 * s HP 0 – telemetrie P45A pak uzná finále `boss`. Rozzuření `DUEL_ENRAGE` zůstává, HUD čte HP z čítače.
 * Uložené `genre.v3` duely staví bajtově týž svět a robot hraje týž hash.
 *
 * Co by vypadalo dobře a bylo špatně: zásah na tělo už za úder, který porazil předposledního soupeře
 * (šampion by začínal o HP níž a čítač by s tělem nesouhlasil); šampion od prvního soupeře (zásahy celé
 * hry by se počítaly bossovi); šampion, který po knockoutu zmizí (scéna by soupeře neměla koho položit).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, FLAG, HEADER, type PieceRef, UNIT, bodyBase, bodyHp, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { play } from '../pieces/behaviours/__tests__/harness';
import { DUEL_COUNTER, DUEL_ENRAGE, DUEL_FOE, type DuelControlParams } from '../pieces/duel';
import { FINALE_GENRE_VERSION, genreAtLeast } from '../pieces/pacing-parts';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BAND_SEEDS = Array.from({ length: 20 }, (_, k) => k + 1);
const cellSpec = (): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === 'duel.default')!));
const draft = (text: string): GameSpecV1 => draftGameSpecWithMeta(text, 1).spec;
const withVersion = (spec: GameSpecV1, version: string): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: version } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const duelOf = (world: ArcadeWorld): DuelControlParams => chain(world.control).find((ref) => ref.id === 'duel')!.params as unknown as DuelControlParams;
interface JudgeParams {
  readonly goal: number;
  readonly champion?: { readonly body: number; readonly after: number };
}
const judgeOf = (world: ArcadeWorld): JudgeParams => world.rules.map(underlyingRule).find((rule) => rule.id === 'judge')!.params as unknown as JudgeParams;
const kindOf = (world: ArcadeWorld, state: Int32Array, body: number): string | undefined => world.kinds[state[bodyBase(body) + BODY.kind] as number];
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Duel: buňka P41 a věty dev sady P47A (d01–d04). */
const DUEL_GAMES: readonly [string, () => GameSpecV1][] = [
  ['cell duel.default', cellSpec],
  ['d01 knight', () => draft('A knight duels a dragon in a castle courtyard')],
  ['d02 ninja', () => draft('A ninja battles a samurai on a bridge')],
  ['d03 cowboy', () => draft('A cowboy faces an outlaw at high noon')],
  ['d04 wizard', () => draft('A wizard duels a witch with magic spells')],
];

/** Uložené `genre.v3` duely nad `07a7491b` (= `abe38f04` pro duel): sha256 světa a hash robota intermediate. */
const STORED_PINS: readonly { readonly seed: number; readonly world: string; readonly bot: string }[] = [
  { seed: 1, world: 'f5d103fb568a3e7a88f6e432e9d2b7248b415675bd292e713b094fef2b9d9105', bot: '1318b965' },
  { seed: 2, world: '3cf1540abd11ebdc7c6250817a9ee4f1cb08140a0f3ce8eb5715009bd9255304', bot: '3d472262' },
];

describe('duel champion takes real hits (P47A T6, genre.v4)', () => {
  for (const [name, specOf] of DUEL_GAMES) {
    it(`${name}: the last opponent's body is a boss template, the judge hits it only after the second-to-last falls`, () => {
      const spec = specOf();
      expect(genreAtLeast(spec, FINALE_GENRE_VERSION)).toBe(true);
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        const duel = duelOf(world);
        const rounds = duel.rounds ?? 1;
        const champion = duel.champion!;
        expect(champion, `${name} seed ${seed}: champion`).toBeDefined();
        // Rozzuření posledního soupeře zůstává.
        expect(duel.enrage).toEqual(DUEL_ENRAGE);
        const start = instantiate(world);
        // Hned za dvěma těly generátoru (hráč, soupeř): indexy úrovně se neposunou.
        expect(champion.body).toBe(DUEL_FOE + 1);
        expect(alive(start, champion.body), 'the champion body is a template').toBe(false);
        expect(kindOf(world, start, champion.body)).toBe('boss');
        // `bossBody`: 9/4 soupeře v každém rozměru.
        for (const slot of ['w', 'h', 'd'] as const) {
          expect(start[bodyBase(champion.body) + BODY[slot]]).toBe(Math.trunc(((start[bodyBase(DUEL_FOE) + BODY[slot]] as number) * 9) / 4));
        }
        expect(kindOf(world, start, DUEL_FOE)).not.toBe('boss');
        expect(bodyHp(start, DUEL_FOE)).toBe(0);
        // Šampion od posledního soupeře, ne od prvního: předposlední padne po foeHealth × (rounds − 1) zásazích.
        expect(rounds).toBeGreaterThan(1);
        expect(judgeOf(world).champion).toEqual({ body: DUEL_FOE, after: duel.foeHealth * (rounds - 1) });
        expect(judgeOf(world).goal).toBe(duel.foeHealth * rounds);
        // Telemetrie chce ≥ 3 zásahy bosse; generátor dává soupeři 4–6 HP.
        expect(duel.foeHealth).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${name}: each strike on the champion is one hit on its body, the knockout leaves it lying at HP 0, telemetry says boss`, () => {
      const spec = specOf();
      let wins = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const duel = duelOf(world);
        const after = duel.foeHealth * ((duel.rounds ?? 1) - 1);
        const championKind = kindOf(world, instantiate(world), duel.champion!.body);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        if (bot.outcome !== 'won') continue;
        wins += 1;
        let bodyHits = 0;
        let crowned = -1;
        const end = play(world, bot.inputs, (state, tick, effects: readonly ArcadeEffect[]) => {
          const p = bodyBase(state[HEADER.player] as number);
          const hits = Math.floor((state[p + BODY.z] as number) / UNIT);
          const struck = (state[p + BODY.aux0] as number) === 1;
          const onFoe = effects.filter((effect) => effect.kind === 'hit' && effect.body === DUEL_FOE);
          bodyHits += onFoe.length;
          if (hits < after) {
            expect(kindOf(world, state, DUEL_FOE), `${name} seed ${seed} tick ${tick}: no champion before the last opponent`).not.toBe('boss');
            expect(bodyHp(state, DUEL_FOE)).toBe(0);
          }
          if (crowned < 0 && kindOf(world, state, DUEL_FOE) === 'boss') crowned = hits;
          // Úder na šampiona = právě jeden zásah těla za 1 HP; úder, který porazil předposledního, ne.
          expect(onFoe, `${name} seed ${seed} tick ${tick}: hits on the body`).toHaveLength(struck && hits > after ? 1 : 0);
          for (const effect of onFoe) expect(effect).toMatchObject({ by: state[HEADER.player], amount: 1 });
          // HUD čte HP z čítače: tělo šampiona s ním souhlasí.
          if (hits >= after) expect(bodyHp(state, DUEL_FOE), `${name} seed ${seed} tick ${tick}: HP = counter`).toBe(state[HEADER.counters + DUEL_COUNTER.foeHealth]);
        });
        expect(crowned, `${name} seed ${seed}: champion arrives when the second-to-last falls`).toBe(after);
        expect(bodyHits).toBe(duel.foeHealth);
        // Knockout: soupeř zůstane ležet (živé tělo s HP 0), jako poražený v `arena.fight`.
        expect(alive(end, DUEL_FOE)).toBe(true);
        expect(bodyHp(end, DUEL_FOE)).toBe(0);
        expect(kindOf(world, end, DUEL_FOE)).toBe(championKind);
        expect(funMetrics(traceRun(world, bot.inputs)).finale.why, `${name} seed ${seed}: finale`).toBe('boss');
      }
      expect(wins, `${name}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 600_000);
  }

  it('cell duel.default: bands on 20 seeds – intermediate ≥ 0.8, novice 0.3–0.7', () => {
    const spec = cellSpec();
    let intermediate = 0;
    let novice = 0;
    for (const seed of BAND_SEEDS) {
      const world = worldOf(spec, seed);
      if (runBot(world, undefined, { profile: 'intermediate' }).outcome === 'won') intermediate += 1;
      if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
    }
    expect(intermediate / BAND_SEEDS.length).toBeGreaterThanOrEqual(0.8);
    expect(novice / BAND_SEEDS.length).toBeGreaterThanOrEqual(0.3);
    expect(novice / BAND_SEEDS.length).toBeLessThanOrEqual(0.7);
  }, 600_000);

  it('a stored genre.v3 duel has no champion, builds the same world and the bot plays the same hash', () => {
    for (const pin of STORED_PINS) {
      const world = worldOf(withVersion(cellSpec(), 'genre.v3'), pin.seed);
      expect(duelOf(world).champion).toBeUndefined();
      expect(judgeOf(world).champion).toBeUndefined();
      expect(createHash('sha256').update(JSON.stringify(world)).digest('hex'), `seed ${pin.seed}`).toBe(pin.world);
      expect(runBot(world, undefined, { profile: 'intermediate' }).hash, `seed ${pin.seed}`).toBe(pin.bot);
      expect(funMetrics(traceRun(world, runBot(world, undefined, { profile: 'intermediate' }).inputs)).finale.why).toBeNull();
    }
  });
});
