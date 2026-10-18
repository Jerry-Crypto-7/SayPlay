/**
 * Nepřátelé na stanovišti (P51 T6). Úkol na stanovišti měl jen kola, spěch a kopie stanovišť – telemetrie v něm
 * neviděla žádnou hrozbu (věty panelu m04 a u03: 0 chování). Nová hra (`genre.v5`) má dva vrhače zezadu kuchyně
 * (`STATION_FOES`): první přijde se začátkem druhého kola, druhý (větší, role nepřítele) se spěchem – stupňování,
 * ne kulisa. Robot úkolu jim uhýbá sám podél pultu (`quest-bot.ts`, `close`), `pacing_bot` neuhýbá (`own`).
 * Uložená `genre.v4` hra staví týž svět bez nich (`p51-stored-v4.test.ts`, `station-rush.test.ts`).
 *
 * Brány v každé živé buňce stanoviště (12 semínek): nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8, jeho
 * výhry mají finále a aspoň dvě chování telemetrie, novice 0,3–0,7. Co by vypadalo dobře a bylo špatně: vrhač,
 * který nikdy nehodí (telemetrie by ho viděla jako `static`, ale hráč by neuhýbal) – proto i výstřely v běhu.
 *
 * Souboj a hod (P51 T6, druhá část): souboj měl jediné chování (soupeř stojí, `enemy:static`), hod jen kývajícího se
 * terče-bosse (`enemy:roam+spawned`) a jeho konec řídl (věty panelu f02, h05: 1 chování; h03: 1 chování, `rising`
 * false). Nová hra souboje: soupeř každý třetí útok hodí věc (`DUEL_HURL`) – v nápřahu ji drží v ruce, po švihu
 * letí `flight` tiků a zasáhne, až doletí; úhyb na švih ruky (jako na úder) do té doby vyprší. Nová hra hodu: do
 * posledních kol přilétají útočníci (`THROW_DIVE`) – letí po čáře hodu na hráče, sestřelit je jde míčem, a kdo
 * doletí, vezme hráči hody. Co by vypadalo dobře a bylo špatně: věc, která letí jen na oko (zásah by přišel se
 * švihem) – proto robot, který uhýbá na švih, dostane zásah; útočník, který nic nevezme – proto ukradené hody.
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { behavioursOf } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, generatorOf } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type InputEvent, type PieceRef, ROLE, bodyBase, bodyHp, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { play } from '../pieces/behaviours/__tests__/harness';
import { SHOT } from '../pieces/behaviours/sniper';
import { DUEL, DUEL_FOE, DUEL_HURL, DUEL_PHASE } from '../pieces/duel';
import { STATION_FOES } from '../pieces/pacing-parts';
import { THROW, THROW_BOSS, THROW_DIVE, type ThrowRoundsParams, throwFlight } from '../pieces/throw';
import { loadRapier } from '../physics/world';
import { funMetrics, traceRun } from '../telemetry';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const cellsOf = (generator: string) => liveCells().filter((cell) => generatorOf(compileRecipe(assemblyOfCell(cell))) === generator);
const STATION_CELLS = cellsOf('quest_station');
const DUEL_CELLS = cellsOf('duel_arena');
const THROW_CELLS = cellsOf('throw_field');
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const storedV4Of = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v4' } });
const pacingOf = (world: ArcadeWorld): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === 'pacing');
interface PacingParams {
  readonly schedule: readonly { readonly atPermille: number; readonly template: number }[];
  readonly behaviours?: readonly { readonly id: string; readonly template: number }[];
  readonly foeSpots?: readonly number[];
}
const chainOf = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chainOf(base)];
};
const pieceOf = (ref: PieceRef, id: string): PieceRef | undefined => chainOf(ref).find((piece) => piece.id === id);
const sha = (world: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex');
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const read = (state: Int32Array, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;

/**
 * `genre.v4` světy buněk souboje a hodu před T6 (`91ae23d4`): sha256 světa a hash robota intermediate. Uložená hra
 * se nesmí hnout – `p51-stored-v4` souboj ani hod nehlídá (dev sada P51 je nemá).
 */
const STORED_V4_PINS: Readonly<Record<string, readonly { readonly seed: number; readonly world: string; readonly bot: string }[]>> = {
  'duel.default': [
    { seed: 1, world: '389710414ae0641686834dce1909308dbd19ddbac88cf0286d800e85c4655b55', bot: 'cbc98501' },
    { seed: 2, world: '28190b891295fe4854f6912544b5113ca7e9bf8dabebca1cf00c5e9a1946affc', bot: '77845cba' },
  ],
  'throw.default': [
    { seed: 1, world: 'b2ff405ff57bb59ec7ed1dbbff88c1851e13df19ee32797d506dc58e41ec82f3', bot: 'ab8e3fb4' },
    { seed: 2, world: 'f8b4cd59cbd50a30635e43b1011ae6e7e7b171b0434e29822c33134d86a751d8', bot: 'cfb2b9f5' },
  ],
};

interface HurlParams {
  readonly body: number;
  readonly every: number;
  readonly flight: number;
}
const hurlOf = (world: ArcadeWorld): HurlParams | undefined => pieceOf(world.control, 'duel')?.params.hurl as HurlParams | undefined;
/** Svět, jehož robot o hozené věci neví: uhýbá na švih ruky jako před úderem. */
const withoutHurlBot = (world: ArcadeWorld): ArcadeWorld => {
  const strip = (ref: PieceRef): PieceRef => {
    const base = ref.params.base as PieceRef | undefined;
    if (ref.id === 'duel_bot') {
      const { hurl: _hurl, ...params } = ref.params;
      return { ...ref, params };
    }
    return base === undefined ? ref : { ...ref, params: { ...ref.params, base: strip(base) } };
  };
  return { ...world, bot: strip(world.bot) };
};
/** Zásahy běhu podle toho, čím přišly: úder (soupeř byl v nápřahu) a hozená věc (soupeř byl ve fázi hodu). */
function duelHits(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly strikes: number; readonly hurls: number; readonly thrown: number } {
  let phase: number = DUEL_PHASE.ready;
  let strikes = 0;
  let hurls = 0;
  let thrown = 0;
  play(world, inputs, (state) => {
    const p = bodyBase(state[HEADER.player] as number);
    const now = state[bodyBase(DUEL_FOE) + BODY.aux0] as number;
    if (phase === DUEL_PHASE.windup && now === DUEL_PHASE.hurl) thrown += 1;
    if ((state[p + BODY.aux0] as number) === -1) {
      if (phase === DUEL_PHASE.hurl) hurls += 1;
      else strikes += 1;
    }
    phase = now;
  });
  return { strikes, hurls, thrown };
}

const diveOf = (world: ArcadeWorld): ThrowRoundsParams['dive'] => (world.rules.map(underlyingRule).find((rule) => rule.id === 'throw_rounds')!.params as unknown as ThrowRoundsParams).dive;
const roundsOf = (world: ArcadeWorld): ThrowRoundsParams => world.rules.map(underlyingRule).find((rule) => rule.id === 'throw_rounds')!.params as unknown as ThrowRoundsParams;
/** Útočník hodu: živé tělo s podpisem předlohy `template` (role, model, rozměry). */
const isDiver = (state: Int32Array, body: number, template: number): boolean => alive(state, body) && (['role', 'kind', 'w', 'h', 'd'] as const).every((slot) => read(state, body, slot) === read(state, template, slot));
/** Útočníci běhu: kolik jich přiletělo, kolik padlo zásahem a kolik doletělo k hráči (ti vzali hody). */
function diveRun(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly came: number; readonly shot: number; readonly reached: number } {
  const dive = diveOf(world)!;
  let came = 0;
  let shot = 0;
  let reached = 0;
  const live = new Set<number>();
  play(world, inputs, (state) => {
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (isDiver(state, body, dive.template) && !live.has(body)) {
        live.add(body);
        came += 1;
      }
    }
    for (const body of [...live]) {
      if (alive(state, body)) continue;
      live.delete(body);
      if (read(state, body, 'z') <= dive.reach) reached += 1;
      else shot += 1;
    }
  });
  return { came, shot, reached };
}

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T6: station quests have foes', () => {
  it('covers the live station cell', () => {
    expect(STATION_CELLS.map((cell) => cell.id)).toEqual(['quest.station']);
  });

  for (const cell of STATION_CELLS) {
    it(`${cell.id}: a new game brings a thrower with round 2 and a second one with the rush; a stored genre.v4 game has none`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        const pacing = pacingOf(world)!.params as unknown as PacingParams;
        expect(pacing.behaviours?.map((ref) => ref.id), `${cell.id} seed ${seed}`).toEqual(['sniper', 'sniper']);
        expect(behavioursOf(world)).toContain('sniper');
        expect(pacing.foeSpots).toEqual(STATION_FOES.spots);
        const [first, rush] = pacing.behaviours!.map((ref) => pacing.schedule.find((entry) => entry.template === ref.template)!.atPermille);
        expect(first).toBeLessThan(rush!);
        expect(first).toBeLessThanOrEqual(200);
        // Druhý vrhač přijde se spěchem, spolu s kopiemi stanovišť.
        const interact = (world.rules.map(underlyingRule).find((rule) => rule.id === 'interact')!.params as { when: { interact: { rounds: number; rush?: { round: number } } } }).when.interact;
        expect(interact.rush, `${cell.id} seed ${seed}: rush`).toBeDefined();
        const copies = pacing.schedule.filter((entry) => !pacing.behaviours!.some((ref) => ref.template === entry.template));
        expect(copies.map((entry) => entry.atPermille)).toEqual([rush]);
        expect(rush).toBe(Math.floor((interact.rush!.round * 1000) / interact.rounds));
        const stored = worldOf(storedV4Of(spec), seed);
        expect((pacingOf(stored)!.params as unknown as PacingParams).behaviours, `${cell.id} seed ${seed}: v4`).toBeUndefined();
        expect(behavioursOf(stored)).toEqual([]);
      }
    });

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 with a finale and ≥ 2 behaviours, novice 0.3–0.7`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      let intermediate = 0;
      let finales = 0;
      let novice = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const verdict = verifyArcade(world);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual, `${cell.id} seed ${seed}: replay`).toBe(true);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        const trace = traceRun(world, bot.inputs);
        const metrics = funMetrics(trace);
        expect(metrics.behaviourCount, `${cell.id} seed ${seed}: behaviours ${metrics.behaviours.join(', ')}`).toBeGreaterThanOrEqual(2);
        // Vrhač opravdu hází: výstřely přeletí kuchyň (vzniknou po startu a zmizí za hranou plochy).
        const shots = trace.samples.flatMap((sample) => sample.bodies.filter((body) => body.y === SHOT.y && body.born > 0).map((body) => `${body.body}@${body.born}`));
        expect(new Set(shots).size, `${cell.id} seed ${seed}: shots`).toBeGreaterThanOrEqual(4);
        if (bot.outcome === 'won') {
          intermediate += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          if (metrics.finale.why !== null) finales += 1;
        }
        if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
      }
      expect(intermediate / SEEDS.length, `${cell.id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(finales / intermediate, `${cell.id}: finale in wins`).toBeGreaterThanOrEqual(0.8);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeGreaterThanOrEqual(0.3);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeLessThanOrEqual(0.7);
    });
  }
});

describe('P51 T6: the duel foe hurls things', () => {
  it('covers the live duel cell', () => {
    expect(DUEL_CELLS.map((cell) => cell.id)).toEqual(['duel.default']);
  });

  it('drafted duels (panel f02, h05, the P47B sumo) hurl in a new game and not as stored genre.v4 games', () => {
    for (const text of ['an ogre arm wrestles a frost giant in a smoky mountain tavern', 'boxing a kangaroo in the australian outback', 'a sumo bear shoves rivals out of the ring']) {
      const { spec } = draftGameSpecWithMeta(text, 1);
      expect(spec.control, text).toBe('duel');
      expect(hurlOf(worldOf(spec)), text).toEqual({ body: DUEL_FOE + 2, every: DUEL_HURL.every, flight: DUEL_HURL.flight });
      expect(hurlOf(worldOf(storedV4Of(spec))), text).toBeUndefined();
    }
  });

  for (const cell of DUEL_CELLS) {
    it(`${cell.id}: a new game hurls every few attacks from a hazard body behind the champion; a stored genre.v4 game builds the same world`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        const hurl = hurlOf(world)!;
        expect(hurl, `${cell.id} seed ${seed}: hurl`).toEqual({ body: DUEL_FOE + 2, every: DUEL_HURL.every, flight: DUEL_HURL.flight });
        // Šampion zůstává hned za soupeřem, věc je předloha za ním: mrtvá na startu, role hrozby.
        expect((pieceOf(world.control, 'duel')!.params.champion as { body: number }).body).toBe(DUEL_FOE + 1);
        const start = instantiate(world);
        expect(alive(start, hurl.body)).toBe(false);
        expect(read(start, hurl.body, 'role')).toBe(ROLE.hazard);
        expect(pieceOf(world.bot, 'duel_bot')!.params.hurl).toEqual({ body: hurl.body, flight: hurl.flight });
        // Úhyb trvá `DUEL.dodge` tiků: kdo uhne na švih ruky, tomu vyprší dřív, než věc doletí.
        expect(hurl.flight).toBeGreaterThan(DUEL.dodge);
        const stored = worldOf(storedV4Of(spec), seed);
        expect(hurlOf(stored), `${cell.id} seed ${seed}: v4`).toBeUndefined();
        expect(pieceOf(stored.bot, 'duel_bot')!.params.hurl).toBeUndefined();
      }
      for (const pin of STORED_V4_PINS[cell.id]!) {
        const stored = worldOf(storedV4Of(spec), pin.seed);
        expect(sha(stored), `${cell.id} seed ${pin.seed}: stored world`).toBe(pin.world);
        expect(runBot(stored, undefined, { profile: 'intermediate' }).hash, `${cell.id} seed ${pin.seed}: stored bot`).toBe(pin.bot);
      }
    });

    it(`${cell.id}: the hurled thing waits in the hand, flies to the player and hits whoever ducked at the arm swing`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      let blind = 0;
      let seen = 0;
      for (const seed of SEEDS.slice(0, 4)) {
        const world = worldOf(spec, seed);
        const hurl = hurlOf(world)!;
        // Nečinný hráč: věc drží soupeř v nápřahu na místě, po švihu letí `flight` tiků k hráči a zasáhne ho.
        let held = 0;
        let flying = 0;
        let lastZ = Number.POSITIVE_INFINITY;
        let phase: number = DUEL_PHASE.ready;
        let hits = 0;
        play(world, [], (state) => {
          const now = state[bodyBase(DUEL_FOE) + BODY.aux0] as number;
          if (alive(state, hurl.body) && now === DUEL_PHASE.windup) held += 1;
          if (now === DUEL_PHASE.hurl) {
            flying += 1;
            expect(read(state, hurl.body, 'z'), `${cell.id} seed ${seed}: flies at the player`).toBeLessThan(lastZ);
            lastZ = read(state, hurl.body, 'z');
          } else lastZ = Number.POSITIVE_INFINITY;
          if (phase === DUEL_PHASE.hurl && now !== DUEL_PHASE.hurl) {
            expect(state[bodyBase(state[HEADER.player] as number) + BODY.aux0], `${cell.id} seed ${seed}: a still player is hit`).toBe(-1);
            expect(alive(state, hurl.body)).toBe(false);
            hits += 1;
          }
          phase = now;
        });
        expect(hits, `${cell.id} seed ${seed}: hurls before the idle player fell`).toBeGreaterThanOrEqual(1);
        expect(held).toBeGreaterThan(0);
        expect(flying).toBe(hits * hurl.flight);
        // Robot, který o věci neví, uhne na švih ruky – a věc ho zasáhne; robot světa ji přečká.
        blind += duelHits(withoutHurlBot(world), runBot(withoutHurlBot(world), undefined, { profile: 'intermediate' }).inputs).hurls;
        seen += duelHits(world, runBot(world, undefined, { profile: 'intermediate' }).inputs).hurls;
      }
      expect(blind, `${cell.id}: hurls that hit a bot ducking at the arm swing`).toBeGreaterThanOrEqual(4);
      expect(seen, `${cell.id}: hurls that hit the world's bot`).toBeLessThan(blind / 2);
    }, 600_000);

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 with a finale and ≥ 2 behaviours, novice 0.3–0.7`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      let intermediate = 0;
      let finales = 0;
      let novice = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const verdict = verifyArcade(world);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual, `${cell.id} seed ${seed}: replay`).toBe(true);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        const metrics = funMetrics(traceRun(world, bot.inputs));
        expect(metrics.behaviourCount, `${cell.id} seed ${seed}: behaviours ${metrics.behaviours.join(', ')}`).toBeGreaterThanOrEqual(2);
        expect(metrics.behaviours.some((signature) => signature.startsWith('hazard:')), `${cell.id} seed ${seed}: the hurled thing`).toBe(true);
        // Stoupání (`pacing-static-a` ho pro `genre.v4` měří údery po třetinách): telemetrie nové hry má konec hustší.
        expect(metrics.rising, `${cell.id} seed ${seed}: rising (${metrics.intensityRatio})`).toBe(true);
        expect(duelHits(world, bot.inputs).thrown, `${cell.id} seed ${seed}: hurls`).toBeGreaterThanOrEqual(4);
        if (bot.outcome === 'won') {
          intermediate += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeLessThanOrEqual(90);
          if (metrics.finale.why !== null) finales += 1;
        }
        if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
      }
      expect(intermediate / SEEDS.length, `${cell.id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(finales / intermediate, `${cell.id}: finale in wins`).toBeGreaterThanOrEqual(0.8);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeGreaterThanOrEqual(0.3);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeLessThanOrEqual(0.7);
    }, 600_000);
  }
});

describe('P51 T6: throw games end under attack', () => {
  it('covers the live throw cell', () => {
    expect(THROW_CELLS.map((cell) => cell.id)).toEqual(['throw.default']);
  });

  for (const cell of THROW_CELLS) {
    it(`${cell.id}: a new game sends attackers into the last two rounds, each with a throw of its own; the rounds it keeps are the genre.v4 rounds; a stored genre.v4 game builds the same world`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      // Nejvyšší bod plného hodu pod 45° (horní hrana míčku): útočníci čekají nad ním, hodům na cíle nepřekážejí.
      const peak = Math.max(...throwFlight({ aim: 1, charge: THROW.maxCharge }).map((point) => point.y)) + THROW.ballSize;
      for (const seed of SEEDS.slice(0, 4)) {
        const world = worldOf(spec, seed);
        const stored = worldOf(storedV4Of(spec), seed);
        const dive = diveOf(world)!;
        expect(dive, `${cell.id} seed ${seed}: dive`).toBeDefined();
        const start = instantiate(world);
        // Útočník: předloha role nepřítele (míč ho sestřelí), kinematická – hýbe se jen rychlostí, kterou mu dá ovládání.
        expect(alive(start, dive.template)).toBe(false);
        expect(read(start, dive.template, 'role')).toBe(ROLE.enemy);
        expect((read(start, dive.template, 'flags') & FLAG.kinematic) !== 0).toBe(true);
        expect(dive.y).toBeGreaterThan(peak);
        expect(dive.steal).toBe(THROW_DIVE.steal);
        expect(pieceOf(world.control, 'throw')!.params.dive).toEqual({ template: dive.template, drop: -THROW_DIVE.drop, low: THROW_DIVE.low, reach: dive.reach, window: THROW_DIVE.window });
        const rounds = roundsOf(world).rounds;
        const before = roundsOf(stored).rounds;
        // Kola ze `genre.v4`, o nejvýš jedno poslední míň (odhad útočníků jde do rozpočtu, hodiny zůstávají): tytéž cíle,
        // opěry i kyv bonusového terče (křivka rychlostí přes kola před úbytkem).
        expect(before.length - rounds.length, `${cell.id} seed ${seed}: rounds ${before.length} → ${rounds.length}`).toBeGreaterThanOrEqual(0);
        expect(before.length - rounds.length).toBeLessThanOrEqual(1);
        rounds.slice(0, -1).forEach(({ dives: _dives, throws: _throws, ...round }, index) => expect(round, `${cell.id} seed ${seed} round ${index}`).toEqual((({ throws: _was, ...own }) => own)(before[index]!)));
        // Poslední kolo je kolo terče-bosse s HP a rychlostí finále, jako ve `genre.v4`.
        const tough = world.rules.map(underlyingRule).find((rule) => rule.id === 'shot_hit')!.params.tough as number;
        expect(rounds.at(-1)!.swing?.[0]).toBe(tough);
        expect(bodyHp(start, tough)).toBe(THROW_BOSS.hp);
        expect(Math.abs(rounds.at(-1)!.swing![4])).toBe(Math.abs(before.at(-1)!.swing![4]));
        // Útočníci jen v posledních dvou kolech; kolo před posledním má za každého hod navíc.
        const counts = rounds.map((round) => round.dives ?? 0);
        expect(counts.slice(-THROW_DIVE.counts.length).reverse(), `${cell.id} seed ${seed}: attackers by round ${counts.join(',')}`).toEqual(THROW_DIVE.counts.slice(0, Math.min(rounds.length, THROW_DIVE.counts.length)));
        expect(counts.slice(0, -THROW_DIVE.counts.length).every((count) => count === 0)).toBe(true);
        rounds.slice(0, -1).forEach((round, index) => expect(round.throws, `${cell.id} seed ${seed} round ${index}: throws`).toBe(before[index]!.throws + (round.dives ?? 0) * THROW_DIVE.throws));
        expect(diveOf(stored), `${cell.id} seed ${seed}: v4`).toBeUndefined();
        expect(pieceOf(stored.control, 'throw')!.params.dive).toBeUndefined();
      }
      for (const pin of STORED_V4_PINS[cell.id]!) {
        const stored = worldOf(storedV4Of(spec), pin.seed);
        expect(sha(stored), `${cell.id} seed ${pin.seed}: stored world`).toBe(pin.world);
        expect(runBot(stored, undefined, { profile: 'intermediate' }).hash, `${cell.id} seed ${pin.seed}: stored bot`).toBe(pin.bot);
      }
    });

    it(`${cell.id}: attackers wait above the field until the round's targets fall, then come down and creep at the thrower; one that reaches him takes throws; the bot shoots most of them first`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      let came = 0;
      let reached = 0;
      for (const seed of SEEDS.slice(0, 4)) {
        const world = worldOf(spec, seed);
        const dive = diveOf(world)!;
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        // Robot světa: dokud stojí cíl, útočníci čekají nad polem; první se snese až po posledním cíli.
        let descent = -1;
        play(world, bot.inputs, (state, tick) => {
          let targets = false;
          for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (alive(state, body) && read(state, body, 'role') === ROLE.target) targets = true;
          for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
            if (!isDiver(state, body, dive.template)) continue;
            if (targets) expect([read(state, body, 'y'), read(state, body, 'vy'), read(state, body, 'vz')], `${cell.id} seed ${seed} tick ${tick}: waits while a target stands`).toEqual([dive.y, 0, 0]);
            else if (descent < 0 && read(state, body, 'vy') < 0) descent = tick;
          }
        });
        expect(descent, `${cell.id} seed ${seed}: an attacker came down`).toBeGreaterThan(0);
        // Od prvního snesení hráč nehází: útočníci se plíží po čáře hodu, kdo dojde k hráči, vezme hody a zmizí.
        let stolen = 0;
        const last = new Map<number, { readonly y: number; readonly z: number }>();
        play(world, bot.inputs.filter((input) => input.tick < descent), (state, _tick, effects) => {
          for (const [body, was] of [...last]) {
            const gone = effects.some((effect) => effect.kind === 'despawn' && effect.body === body);
            const took = effects.find((effect) => effect.kind === 'count' && effect.counter === 'ammo' && effect.amount < 0);
            if (gone && took !== undefined && took.kind === 'count' && read(state, body, 'z') <= dive.reach) {
              // Vezme nejvýš `steal` hodů a hodů neubude pod nulu.
              stolen += 1;
              expect(-took.amount).toBeLessThanOrEqual(THROW_DIVE.steal);
              expect(was.z, `${cell.id} seed ${seed}: taken only at the thrower`).toBeGreaterThan(dive.reach);
              expect(state[HEADER.counters + COUNTER.ammo]).toBeGreaterThanOrEqual(0);
            }
            if (!alive(state, body)) last.delete(body);
          }
          for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
            if (!isDiver(state, body, dive.template)) continue;
            // Po čáře hodu dolů a k hráči, nikdy zpátky; plíží se ve výšce `low`.
            expect(read(state, body, 'x')).toBe(0);
            const was = last.get(body);
            if (was !== undefined) {
              expect(read(state, body, 'y')).toBeLessThanOrEqual(was.y);
              expect(read(state, body, 'z')).toBeLessThanOrEqual(was.z);
            }
            if (read(state, body, 'vz') < 0) expect(read(state, body, 'y')).toBe(THROW_DIVE.low);
            last.set(body, { y: read(state, body, 'y'), z: read(state, body, 'z') });
          }
        });
        expect(stolen, `${cell.id} seed ${seed}: attackers that took throws from a thrower who stopped`).toBeGreaterThan(0);
        const run = diveRun(world, bot.inputs);
        came += run.came;
        reached += run.reached;
      }
      expect(came).toBeGreaterThanOrEqual(4 * THROW_DIVE.counts[0]!);
      expect(reached / came, `${cell.id}: attackers that reached the intermediate bot`).toBeLessThanOrEqual(0.2);
    }, 600_000);

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 with a finale, ≥ 2 behaviours and rising, novice 0.3–0.7`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      let intermediate = 0;
      let finales = 0;
      let novice = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const verdict = verifyArcade(world);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual, `${cell.id} seed ${seed}: replay`).toBe(true);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        const metrics = funMetrics(traceRun(world, bot.inputs));
        expect(metrics.behaviourCount, `${cell.id} seed ${seed}: behaviours ${metrics.behaviours.join(', ')}`).toBeGreaterThanOrEqual(2);
        expect(metrics.behaviours, `${cell.id} seed ${seed}`).toContain('enemy:chase+spawned');
        expect(metrics.rising, `${cell.id} seed ${seed}: rising (${metrics.intensityRatio})`).toBe(true);
        if (bot.outcome === 'won') {
          intermediate += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          if (metrics.finale.why !== null) finales += 1;
        }
        if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
      }
      expect(intermediate / SEEDS.length, `${cell.id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(finales / intermediate, `${cell.id}: finale in wins`).toBeGreaterThanOrEqual(0.8);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeGreaterThanOrEqual(0.3);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeLessThanOrEqual(0.7);
    }, 600_000);
  }
});
