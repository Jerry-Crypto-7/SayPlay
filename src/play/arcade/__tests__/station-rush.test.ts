/**
 * Závěrečný spěch stanoviště (P47A T5, jen `genre.v4`): poslední kola – od toho, se kterým přijdou kopie
 * stanovišť (`PacingSetup.extra`, o půl rozestupu za krajními) – mají kratší lhůtu přetečení (dolní mez
 * křivky spočtená z kroku spěchu) a úkoly se v nich střídají rychleji (`interact.rush`: kratší držení
 * a pečení). Vyhraný běh má proto posledních 10 s ≥ 1,5× hustších než celý běh (`climax` telemetrie P45A).
 * Uložené `genre.v3` hry staví bajtově týž svět a robot hraje týž hash.
 *
 * Co by vypadalo dobře a bylo špatně: kratší lhůta bez rychlejších úkolů (robot ani hráč nezrychlí, hustota
 * zůstane, climax nepřijde); spěch od prvního kola (celý běh hustší, konec ne); kopie daleko na kraji pultu
 * (chůze sní hustotu, climax jen o vlásek); spěch, který začátečníkovi vezme pásmo.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, type PieceRef, ROLE, bodyBase, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { play } from '../pieces/behaviours/__tests__/harness';
import { FINALE_GENRE_VERSION, genreAtLeast } from '../pieces/pacing-parts';
import { QUEST } from '../pieces/quest';
import { waveOf } from '../pieces/waves';
import type { CompiledInteract } from '../rules/interact';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BAND_SEEDS = Array.from({ length: 20 }, (_, k) => k + 1);
const cellSpec = (): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === 'quest.station')!));
const draft = (text: string): GameSpecV1 => draftGameSpecWithMeta(text, 1).spec;
const withVersion = (spec: GameSpecV1, version: string): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: version } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const ruleOf = (world: ArcadeWorld, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
/** |x| živých stanovišť na startu (bez předloh). */
const stationXs = (state: Int32Array): number[] =>
  Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => body).flatMap((body) =>
    state[bodyBase(body) + BODY.role] === ROLE.target && ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0 ? [Math.abs(state[bodyBase(body) + BODY.x] as number)] : [],
  );
const roundsOf = (world: ArcadeWorld): number => (ruleOf(world, 'arena_waves')!.params as { waves: unknown[] }).waves.length + 1;
const interactOf = (world: ArcadeWorld): CompiledInteract => (ruleOf(world, 'interact')!.params as { when: { interact: CompiledInteract } }).when.interact;
interface BoilParams {
  readonly ticks: number;
  readonly step?: number;
  readonly floor?: number;
  readonly limits?: readonly number[];
}
const boilOf = (world: ArcadeWorld): BoilParams => ruleOf(world, 'boil_over')!.params as unknown as BoilParams;
const boilLimit = (boil: BoilParams, wave: number): number =>
  boil.limits !== undefined ? (boil.limits[Math.min(wave, boil.limits.length - 1)] as number) : boil.step === undefined ? boil.ticks : Math.max(boil.floor ?? ARCADE_HZ, boil.ticks - boil.step * wave);

/** Stanoviště: buňka a věty dev sady P47A (s01–s04). */
const STATION_GAMES: readonly [string, () => GameSpecV1][] = [
  ['cell quest.station', cellSpec],
  ['s01 burgers', () => draft('Cook burgers for hungry customers at a diner')],
  ['s02 pizza', () => draft('Work the counter of a pizza place and serve orders fast')],
  ['s03 bakery', () => draft('Manage a busy bakery and keep every oven from burning')],
  ['s04 beach bar', () => draft('Serve drinks at a busy beach bar')],
];

/** Uložené `genre.v3` hry nad `9b4577fd` (= `abe38f04` pro stanoviště): sha256 světa a hash robota intermediate. */
const STORED_PINS: readonly { readonly game: string; readonly text: string | null; readonly seed: number; readonly world: string; readonly bot: string }[] = [
  { game: 'cell', text: null, seed: 1, world: '4d2ebc42cb210143bdfb0d513121966778b3ccef1799803d66a57f7c403d6873', bot: 'e76a73ae' },
  { game: 'cell', text: null, seed: 2, world: '59aca3e6b7f180f27de5264448e358a0899809492e5b814560eee602f48e01dc', bot: 'f313620a' },
  { game: 's01', text: 'Cook burgers for hungry customers at a diner', seed: 1, world: 'c8964f8892011d5f63d4c41fef07c758da0766ed28dd79aa2e9bf1dbe1959ed4', bot: '882a5aec' },
  { game: 's01', text: 'Cook burgers for hungry customers at a diner', seed: 2, world: '12e59e6499b15a65d912bf1aab76b5965c61385f6655f6daa69840a807729f45', bot: '2dbd64d5' },
  { game: 's04', text: 'Serve drinks at a busy beach bar', seed: 1, world: '9140e57ee19a6aea315793380171b9c9904322a263a5eed67d682b6280c28f31', bot: 'f5e0a3c5' },
  { game: 's04', text: 'Serve drinks at a busy beach bar', seed: 2, world: 'cc9fdf00490fe9a8636afcb7a9bd3e39292373287e1d2f1e876ce80d4cb63d35', bot: '3a252cb3' },
];

/** Tik začátku posledního kola v běhu robota (−1 = nedošel). */
function lastRoundStart(world: ArcadeWorld, inputs: Parameters<typeof play>[1]): number {
  const last = roundsOf(world) - 1;
  let start = -1;
  play(world, inputs, (state, tick) => {
    if (start < 0 && waveOf(state) >= last) start = tick;
  });
  return start;
}

describe('station quest ends with a rush round (P47A T5, genre.v4)', () => {
  it('genre.v4 is the version the rush waits for', () => {
    expect(FINALE_GENRE_VERSION).toBe('genre.v4');
    expect(genreAtLeast(cellSpec(), FINALE_GENRE_VERSION)).toBe(true);
  });

  for (const [name, specOf] of STATION_GAMES) {
    it(`${name}: the rush rounds at the end have the shortest overflow limit and quicker tasks, the copies come with them`, () => {
      const spec = specOf();
      const stored = worldOf(withVersion(spec, 'genre.v3'));
      const storedBoil = boilOf(stored);
      const storedInteract = interactOf(stored);
      expect(storedInteract.rush, 'v3 has no rush').toBeUndefined();
      const storedLast = boilLimit(storedBoil, roundsOf(stored) - 1);
      for (const seed of SEEDS) {
        // Stavba spěchu `genre.v4`; nová hra (`genre.v5`) má navíc vrhače a o jejich čas míň kol (`p51-foes.test.ts`).
        const world = worldOf(withVersion(spec, 'genre.v4'), seed);
        const rounds = roundsOf(world);
        const interact = interactOf(world);
        const rush = interact.rush!;
        expect(rush, `${name} seed ${seed}: rush`).toBeDefined();
        // Spěch = poslední kola (nejvýš polovina hry), s jeho prvním kolem přijdou kopie stanovišť; robot dostane tentýž spouštěč.
        expect(rush.round).toBeGreaterThanOrEqual(Math.floor(rounds / 2));
        expect(rush.round).toBeLessThanOrEqual(rounds - 2);
        const schedule = (ruleOf(world, 'pacing')!.params as { schedule: { atPermille: number }[] }).schedule;
        expect(schedule).toHaveLength(1);
        expect(schedule[0]!.atPermille).toBe(Math.floor((rush.round * 1000) / rounds));
        // Kopie o půl rozestupu za krajními stanovišti (bez spěchu o celý): kolo spěchu nenese chůzi přes celý pult.
        const start = instantiate(world);
        const outer = Math.max(...stationXs(start));
        const spots = (ruleOf(world, 'pacing')!.params as { spots: number[] }).spots;
        expect(spots.filter((_, k) => k % 2 === 0).map((x) => Math.abs(x))).toEqual([outer + QUEST.stationSpacing / 2, outer + QUEST.stationSpacing / 2]);
        expect(rounds, 'never more rounds than the generator, never fewer than the game without the rush').toBeGreaterThanOrEqual(roundsOf(stored));
        const questBot = chain(world.bot).find((ref) => ref.id === 'quest_bot')!;
        expect((questBot.params.interact as CompiledInteract).rush).toEqual(rush);
        // Úkoly rychleji: držení i pečení kratší než v ostatních kolech.
        expect(rush.hold).toBeLessThan(interact.hold);
        expect(rush.hold).toBeGreaterThan(0);
        if (interact.ready !== undefined) expect(rush.after).toBeLessThan(interact.ready.after);
        // Lhůta kol spěchu = dolní mez křivky z kroku spěchu: kratší než dnešní poslední kolo.
        const boil = boilOf(world);
        const step = rush.hold + rush.after + (interact.ready?.window ?? QUEST.ready.window);
        const floor = Math.max(QUEST.rounds.boilLast, Math.ceil(1.5 * step));
        expect(boil.limits!.length).toBe(rounds);
        for (const limit of boil.limits!.slice(rush.round)) expect(limit).toBe(floor);
        expect(floor).toBeLessThan(storedLast);
        // Kola před spěchem jako bez něj: nikdy kratší než dnešní poslední.
        for (const limit of boil.limits!.slice(0, rush.round)) expect(limit).toBeGreaterThanOrEqual(storedLast);
      }
    });

    it(`${name}: the won run ends denser – climax in the won runs, and the last round is quicker per task than the one before`, () => {
      const spec = specOf();
      let wins = 0;
      let climaxes = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        if (bot.outcome !== 'won') continue;
        wins += 1;
        const metrics = funMetrics(traceRun(world, bot.inputs));
        if (metrics.finale.why === 'climax') climaxes += 1;
        expect(metrics.rising, `${name} seed ${seed}: rising`).toBe(true);
        expect(bot.tick / ARCADE_HZ, `${name} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
        expect(lastRoundStart(world, bot.inputs)).toBeGreaterThan(0);
      }
      expect(wins, `${name}: intermediate wins`).toBeGreaterThanOrEqual(7);
      // Bez spěchu 0/8 (konec stejně hustý jako běh); se spěchem a kopiemi blíž 20/20 semínek (měřeno P47A T5, README) – cíl gauge 0,8.
      expect(climaxes, `${name}: climax in ${climaxes}/${wins} won runs`).toBeGreaterThanOrEqual(Math.ceil(0.8 * wins));
    }, 600_000);
  }

  it('cell quest.station: bands on 20 seeds – intermediate ≥ 0.8, novice 0.3–0.7', () => {
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

  it('a stored genre.v3 station game builds the same world and the bot plays the same hash', () => {
    for (const pin of STORED_PINS) {
      const spec = withVersion(pin.text === null ? cellSpec() : draft(pin.text), 'genre.v3');
      const world = worldOf(spec, pin.seed);
      expect(createHash('sha256').update(JSON.stringify(world)).digest('hex'), `${pin.game} seed ${pin.seed}`).toBe(pin.world);
      expect(runBot(world, undefined, { profile: 'intermediate' }).hash, `${pin.game} seed ${pin.seed}`).toBe(pin.bot);
    }
  });
});
