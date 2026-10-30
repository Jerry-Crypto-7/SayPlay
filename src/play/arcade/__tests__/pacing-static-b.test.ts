/**
 * Průběh hodu, načasování, rytmu, úkolu na stanovišti a přistání (P45C T14).
 *
 * Hod: v každém kole visí za cíli pohyblivý bonusový terč (kyvadlo jádra), kolo
 * od kola rychlejší podle křivky; finále = bonusový terč posledního kola,
 * poslední krok k výhře. Načasování: rychlost jezdce po kolech z křivky (okno
 * nikdy užší než dnešní nejužší), finále náhlá smrt v posledních třech kolech.
 * Rytmus: písnička z generátoru nad `placeByCurve` – úvod řídký, vrchol a
 * finále husté, dráhy ve frázích dvou vzorů (`walk`, `trill`), finále rychlá
 * závěrečná fráze. Stanoviště: lhůta přetečení kola jde s křivkou (kola
 * zrychlují), finále poslední kolo s dvojím úkolem (kopie stanovišť); ve
 * `genre.v4` (P47A T5) závěrečný spěch – kopie přijdou s ním a jeho kola mají
 * kratší lhůtu než dnešní poslední (`station-rush.test.ts`).
 *
 * Odchylka měřidla: tyhle žánry nemají hrozby, tlak `pressureRun` je 0 –
 * stoupání se měří tím, co hra opravdu zrychluje: načasování rychlostí jezdce,
 * rytmus notami do 3 s před lištou, hod rychlostí nejrychlejšího živého
 * pohyblivého terče, stanoviště tempem, které chce (1000 / lhůta přetečení kola).
 * Přistání zůstává bez průběhu (odchylka T14: jeden život a hra 14 s – délka
 * 30–90 s se průběhem nedá dosáhnout). Žádné finále nepřidá výhru ani obal výhry.
 */

import { describe, expect, it } from 'vitest';

import { finaleOf, pressureRun } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, generatorOf } from '../compile';
import { ARCADE_HZ, type ArcadeState, type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, type PieceRef, ROLE, UNIT, bodyBase, targetStateOf, underlyingRule } from '../contract';
import { instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { play } from '../pieces/behaviours/__tests__/harness';
import { TENSION_CURVE, intensityAt } from '../pieces/pacing';
import { GENRE_PACING, STATION_PACE, TIMING_PACE, timingFinaleSpeeds, timingPacedSpeeds } from '../pieces/pacing-parts';
import { RHYTHM, RHYTHM_CURVE, beatMap, checkRhythmLevel, rhythmLaneOfX, rhythmLevel, rhythmTicks } from '../pieces/rhythm';
import { THROW_SWING, swingSpeed } from '../pieces/throw';
import { TIMING_SLOTS, judgeRule, timingLevel, timingSpeedOf, timingWindowTicks } from '../pieces/timing';
import { waveOf } from '../pieces/waves';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

const STATIC_B = ['throw_field', 'timing_level', 'rhythm_level', 'quest_station', 'voyage_land'];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const CELLS = liveCells().filter((cell) => {
  const spec = compileRecipe(assemblyOfCell(cell));
  return spec.genre !== undefined && STATIC_B.includes(generatorOf(spec));
});
const PACED = CELLS.filter((cell) => cell.id !== 'voyage.land');
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(CELLS.find((cell) => cell.id === id)!));

const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Tatáž hra uložená před průběhem (`genre.v1`). */
const storedOf = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });
/** Tatáž hra uložená před finále P51 (`genre.v4`): načasování po křivce; nové finále je v `p51-ball-catch-timing.test.ts`. */
const storedV4Of = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v4' } });

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const ruleOf = (world: ArcadeWorld, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const bodies = (state: ArcadeState): number[] => Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => body);

interface BoilParams {
  readonly ticks: number;
  readonly step?: number;
  readonly floor?: number;
  readonly limits?: readonly number[];
}
const boilLimit = (boil: BoilParams, wave: number): number =>
  boil.limits !== undefined ? (boil.limits[Math.min(wave, boil.limits.length - 1)] as number) : boil.step === undefined ? boil.ticks : Math.max(boil.floor ?? ARCADE_HZ, boil.ticks - boil.step * wave);

/** Co žánr zrychluje, vzorek po tiku (odchylka měřidla, viz hlavička). */
function genrePressure(world: ArcadeWorld): (state: ArcadeState) => number {
  const control = chain(world.control).at(-1)!.id;
  if (control === 'timing') return (state) => Math.abs(state[bodyBase(TIMING_SLOTS.slider) + BODY.vx] as number);
  if (control === 'rhythm') {
    // Noty do 3 s před lištou: hustota, kterou hráč vidí.
    return (state) => bodies(state).filter((body) => body > 0 && alive(state, body) && (state[bodyBase(body) + BODY.z] as number) >= 0 && (state[bodyBase(body) + BODY.z] as number) < RHYTHM.noteSpeed * 3 * ARCADE_HZ).length;
  }
  if (control === 'throw') {
    // Kývající se terče: bonusové a ve `genre.v4` terč-boss posledního kola (role nepřítele, P47A T7).
    const swinging = (role: number): boolean => role === ROLE.target || role === ROLE.enemy;
    return (state) =>
      Math.max(0, ...bodies(state).filter((body) => alive(state, body) && swinging(state[bodyBase(body) + BODY.role] as number) && ((state[bodyBase(body) + BODY.flags] as number) & FLAG.kinematic) !== 0).map((body) => Math.abs(state[bodyBase(body) + BODY.vx] as number)));
  }
  const boil = ruleOf(world, 'boil_over')!.params as unknown as BoilParams;
  return (state) => 1000 / boilLimit(boil, waveOf(state));
}

function thirds(samples: readonly number[]): [number, number, number] {
  const cut = (k: number): number => Math.round((samples.length * k) / 3);
  const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  return [mean(samples.slice(0, cut(1))), mean(samples.slice(cut(1), cut(2))), mean(samples.slice(cut(2)))];
}

describe('static genres B are paced (throw, timing, rhythm, station quest; landing stays unpaced)', () => {
  it('covers every live cell of these genres', () => {
    expect(CELLS.map((cell) => cell.id).sort()).toEqual(['quest.station', 'rhythm.default', 'throw.default', 'timing.bridge', 'timing.precision', 'timing.stack', 'voyage.land']);
  });

  for (const cell of PACED) {
    it(`${cell.id}: rising, a finale, bot wins 7/8 in 30–90 s, idle loses, replay equal`, () => {
      const spec = cellSpec(cell.id);
      let wins = 0;
      for (const seed of SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const { world } = made;
        expect(chain(world.control).map((ref) => ref.id)).toContain('pacing_control');
        expect(finaleOf(world), `${cell.id} seed ${seed}: finale`).toBe(true);
        const verdict = verifyArcade(world, ARCADE_LIBRARY, made.roleBindings);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual).toBe(true);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        expect(pressureRun(world, bot.inputs).hash).toBe(bot.hash);
        const sample = genrePressure(world);
        const samples: number[] = [];
        play(world, bot.inputs, (state) => samples.push(sample(state)));
        const run = thirds(samples);
        expect(run[2] > 0 && run[2] >= run[0] * 1.15, `${cell.id} seed ${seed}: by thirds ${run.map((value) => value.toFixed(2)).join(' / ')}`).toBe(true);
        if (bot.outcome === 'won') {
          wins += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeLessThanOrEqual(90);
        }
      }
      expect(wins, `${cell.id}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 600_000);
  }

  it('timing (stored genre.v4): no round swings faster than today’s last round, so no window is narrower than today’s narrowest (pin)', () => {
    for (const cell of PACED.filter((own) => own.id.startsWith('timing'))) {
      const spec = storedV4Of(cellSpec(cell.id));
      const params = timingLevel.params.parse({ ...spec.controlParams });
      const today = Array.from({ length: params.rounds }, (_, round) => timingSpeedOf(params, round));
      const paced = timingPacedSpeeds(params);
      const narrowest = timingWindowTicks(Math.max(...today), params.tolerance);
      expect(Math.max(...paced), cell.id).toBe(Math.max(...today));
      for (const speed of paced) expect(timingWindowTicks(speed, params.tolerance), cell.id).toBeGreaterThanOrEqual(narrowest);
      // Finále nové hry (P51 T4) jede rychleji než dnešní poslední kolo, okno v tikách ale užší není.
      for (const speed of timingFinaleSpeeds(params)) expect(timingWindowTicks(speed, params.tolerance), `${cell.id} v5`).toBeGreaterThanOrEqual(narrowest);
      // Úvod pomaleji než stupňování, finále nejrychlejší: rychlost roste s křivkou.
      expect(paced[0]!).toBeLessThan(paced[Math.floor(params.rounds / 2)]!);
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const state = instantiate(world);
        // Svět jede rychlostmi z křivky: jezdec a předlohy kol.
        expect(Math.abs(state[bodyBase(TIMING_SLOTS.slider) + BODY.vx] as number)).toBe(paced[0]);
        paced.forEach((speed, round) => expect(Math.abs(state[bodyBase(TIMING_SLOTS.marks + round) + BODY.vx] as number), `${cell.id} round ${round + 1}`).toBe(speed));
        expect((ruleOf(world, 'judge')!.params as { sudden?: number }).sudden).toBe(TIMING_PACE.sudden);
        expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('sudden');
      }
    }
  });

  it('timing: the sudden death loses on a miss only in the last three rounds, a miss before them costs a life', () => {
    const world = worldOf(cellSpec('timing.stack'));
    const judge = ruleOf(world, 'judge')!.params as { goal: number; miss: 'lose' | 'damage'; sudden: number };
    const outcome = (done: number): string => {
      const state = instantiate(world);
      const player = state[HEADER.player] as number;
      state[bodyBase(player) + BODY.z] = done * UNIT;
      state[bodyBase(player) + BODY.aux0] = -1;
      return judgeRule.fire({ state, player, other: -1, input: NO_INPUT } as never, judge).map((effect) => effect.kind).join();
    };
    expect(judge.miss).toBe('damage');
    expect(outcome(judge.goal - judge.sudden - 1)).toBe('damage');
    for (let done = judge.goal - judge.sudden; done < judge.goal; done += 1) expect(outcome(done)).toBe('lose');
  });

  it('timing (stored genre.v4): the novice never loses inside the sudden death – the finale window is one the novice can hit', () => {
    let reached = 0;
    for (const cell of PACED.filter((own) => own.id.startsWith('timing'))) {
      for (const seed of SEEDS) {
        const world = worldOf(storedV4Of(cellSpec(cell.id)), seed);
        const judge = ruleOf(world, 'judge')!.params as { goal: number; sudden: number };
        const novice = runBot(world, ARCADE_LIBRARY, { profile: 'novice' });
        const done = Math.floor(play(world, novice.inputs, () => {})[bodyBase(0) + BODY.z]! / UNIT);
        if (done < judge.goal - judge.sudden) continue;
        reached += 1;
        expect(novice.outcome, `${cell.id} seed ${seed}: lost in the sudden death after ${done} rounds`).toBe('won');
      }
    }
    expect(reached).toBeGreaterThan(0);
  });

  // Nová hra (`genre.v5`, P51 T4): 20 rychlých kol finále za 34 s hodin – začátečník v náhlé smrti prohrává (4 z 8 semínek),
  // ale hodinami, ne minutím: okno rychlých kol trefí každým ťukem (P51 T5c).
  it('timing (new game): the novice never misses inside the sudden death – a loss there is the clock', () => {
    let reached = 0;
    for (const cell of PACED.filter((own) => own.id.startsWith('timing'))) {
      for (const seed of SEEDS) {
        const world = worldOf(cellSpec(cell.id), seed);
        const judge = ruleOf(world, 'judge')!.params as { goal: number; sudden: number };
        const { seconds } = ruleOf(world, 'time_limit')!.params as { seconds: number };
        const novice = runBot(world, ARCADE_LIBRARY, { profile: 'novice' });
        const misses: number[] = [];
        let endedAt = 0;
        const done = Math.floor(
          play(world, novice.inputs, (state, tick) => {
            endedAt = tick;
            const player = bodyBase(state[HEADER.player] as number);
            if ((state[player + BODY.aux0] as number) < 0 && Math.floor((state[player + BODY.z] as number) / UNIT) >= judge.goal - judge.sudden) misses.push(tick);
          })[bodyBase(0) + BODY.z]! / UNIT,
        );
        if (done < judge.goal - judge.sudden) continue;
        reached += 1;
        expect(misses, `${cell.id} seed ${seed}: missed in the sudden death`).toEqual([]);
        if (novice.outcome !== 'won') expect(endedAt, `${cell.id} seed ${seed}: lost in the sudden death after ${done} rounds`).toBe(seconds * ARCADE_HZ);
      }
    }
    expect(reached).toBeGreaterThan(0);
  });

  it('rhythm: the song is built over the curve – sparse intro, dense finale phrase, two lane patterns', () => {
    const spec = cellSpec('rhythm.default');
    const params = rhythmLevel.params.parse({ ...spec.controlParams });
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const state = instantiate(world);
      const notes = bodies(state).filter((body) => body > 0 && state[bodyBase(body) + BODY.role] === ROLE.target && alive(state, body));
      const ticks = notes.map((body) => (state[bodyBase(body) + BODY.z] as number) / RHYTHM.noteSpeed);
      const own = rhythmLevel.generate(seed, { ...params, curve: true });
      expect(checkRhythmLevel(own, params.window)).toEqual([]);
      expect(ticks).toEqual(rhythmTicks(own));
      // Not je podíl `share` písničky bez průběhu a cíl `judge` jim odpovídá.
      expect(notes.length).toBe(Math.round((beatMap(seed, params).length * RHYTHM_CURVE.share) / 1000));
      expect((ruleOf(world, 'judge')!.params as { goal: number }).goal).toBe(notes.length);
      expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('phrase');
      const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]!);
      const beat = (ARCADE_HZ * 60) / params.bpm;
      // Úvod řídčí než doba, závěrečná fráze (posledních 8 not) rychlejší než doba i než první polovina písničky.
      const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(mean(gaps.slice(0, 4))).toBeGreaterThan(beat);
      expect(mean(gaps.slice(-7))).toBeLessThan(beat);
      expect(mean(gaps.slice(-7))).toBeLessThan(mean(gaps.slice(0, gaps.length >> 1)));
      // Dva vzory drah ve frázích: `walk` (vždy soused) v úvodu, `trill` (dvě dráhy ob jednu) v poslední celé frázi.
      const lanes = notes.map((body) => rhythmLaneOfX(state[bodyBase(body) + BODY.x] as number));
      const phrase = (start: number): number[] => lanes.slice(start, start + RHYTHM_CURVE.phrase);
      const steps = (own: readonly number[]): number[] => own.slice(1).map((lane, index) => Math.abs(lane - own[index]!));
      expect(new Set(steps(phrase(0))), `seed ${seed}: ${phrase(0).join(',')}`).toEqual(new Set([1]));
      const last = (Math.ceil(lanes.length / RHYTHM_CURVE.phrase) - 2) * RHYTHM_CURVE.phrase;
      const closing = phrase(last);
      expect(closing, `seed ${seed}`).toEqual([closing[0], closing[0]! + 2, closing[0], closing[0]! + 2]);
      // Mezi nimi se vzory střídají: obojí ve středu písničky.
      const middle = steps(lanes.slice(RHYTHM_CURVE.phrase, last));
      expect(middle.includes(2) && middle.includes(1), `seed ${seed}`).toBe(true);
    }
  });

  // `genre.v3` = uložená hra P45C (pin beze změny); `genre.v4` (P47A T5) = poslední kola spěch (`interact.rush`, `station-rush.test.ts`).
  for (const version of ['genre.v3', 'genre.v4'] as const) {
    it(`station (${version}): rounds speed up with the curve; ${version === 'genre.v3' ? 'never past today’s last round, the last round doubles the task' : 'the rush rounds sit below today’s last round and the copies come with them'}; the win waits for every station`, () => {
      const cell = cellSpec('quest.station');
      const spec = { ...cell, genre: { ...cell.genre!, compilerVersion: version } };
      const stored = worldOf(storedOf(spec));
      const today = ruleOf(stored, 'boil_over')!.params as unknown as BoilParams;
      const todayRounds = (ruleOf(stored, 'arena_waves')!.params as { waves: unknown[] }).waves.length + 1;
      const todayLast = boilLimit(today, todayRounds - 1);
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const boil = ruleOf(world, 'boil_over')!.params as unknown as BoilParams;
        const rounds = (ruleOf(world, 'arena_waves')!.params as { waves: unknown[] }).waves.length + 1;
        const interact = (ruleOf(world, 'interact')!.params as { when: { interact: { rounds: number; rush?: { round: number } } } }).when.interact;
        expect(interact.rounds).toBe(rounds);
        // Kolo, se kterým přijdou kopie stanovišť: bez spěchu poslední, se spěchem první kolo spěchu.
        const doubled = version === 'genre.v3' ? rounds - 1 : interact.rush!.round;
        if (version === 'genre.v3') {
          expect(interact.rush).toBeUndefined();
          expect(rounds).toBe(todayRounds - STATION_PACE.drop);
        } else {
          // Spěch ubere nejvýš tolik kol jako dřív; kola před ním jako dřív – nikdy kratší než dnešní poslední.
          expect(rounds).toBeGreaterThanOrEqual(todayRounds - STATION_PACE.drop);
          expect(rounds).toBeLessThan(todayRounds);
          expect(doubled).toBeLessThan(rounds - 1);
        }
        // Lhůta z křivky: první kolo jako dnes, pak kratší; bez spěchu poslední jako dnešní poslední – nikdy kratší.
        expect(boil.limits!.length).toBe(rounds);
        expect(boil.limits![0]).toBe(boilLimit(today, 0));
        for (let round = 1; round < rounds; round += 1) expect(boil.limits![round]!).toBeLessThanOrEqual(boil.limits![round - 1]!);
        if (version === 'genre.v3') {
          expect(boil.limits!.at(-1)).toBe(todayLast);
          expect(Math.min(...boil.limits!)).toBeGreaterThanOrEqual(todayLast);
        } else {
          expect(Math.min(...boil.limits!.slice(0, doubled))).toBeGreaterThanOrEqual(todayLast);
          // Kola spěchu: jedna lhůta, kratší než dnešní poslední.
          expect(new Set(boil.limits!.slice(doubled)).size).toBe(1);
          expect(boil.limits!.at(-1)!).toBeLessThan(todayLast);
        }
        expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('round');
        // Robot: s kolem `doubled` přibudou stanoviště (dřív ne), výhra přijde, až jsou hotová všechna.
        const start = instantiate(world);
        const own = bodies(start).filter((body) => start[bodyBase(body) + BODY.role] === ROLE.target && alive(start, body)).length;
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        expect(bot.outcome).toBe('won');
        let doubledAt = -1;
        let won = -1;
        const program = loadProgram(world, ARCADE_LIBRARY);
        const state = instantiate(world);
        let next = 0;
        for (let tick = 0; tick <= bot.tick && state[HEADER.runState] === 0; tick += 1) {
          while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
          const event = bot.inputs[next];
          step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program, (_rule, effect) => {
            if (effect.kind === 'win') won = tick;
          });
          const targets = bodies(state).filter((body) => state[bodyBase(body) + BODY.role] === ROLE.target && alive(state, body));
          if (waveOf(state) < doubled) expect(targets.length, `seed ${seed} tick ${tick}`).toBe(own);
          if (waveOf(state) === doubled && doubledAt < 0 && targets.length === own + Math.min(STATION_PACE.extra, own)) doubledAt = tick;
          if (won >= 0) expect(targets.every((body) => targetStateOf(state, body) >= 1), `seed ${seed}`).toBe(true);
        }
        expect(doubledAt, `seed ${seed}: the round ${doubled} doubled`).toBeGreaterThan(0);
        expect(won).toBeGreaterThan(doubledAt);
      }
    });
  }

  it('throw: every round brings a swinging bonus target, faster with the curve; the last one is the last step to the win', () => {
    // Uložená hra `genre.v3`: ve `genre.v4` je poslední kolo terč-boss se 3 HP (`throw-boss.test.ts`, P47A T7).
    const cell = cellSpec('throw.default');
    const spec: GameSpecV1 = { ...cell, genre: { ...cell.genre!, compilerVersion: 'genre.v3' } };
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('bonus');
      expect(chain(world.control).find((ref) => ref.id === 'throw')!.params.swing).toBe(THROW_SWING.amplitude);
      const state = instantiate(world);
      const first = bodies(state).filter((body) => alive(state, body) && ((state[bodyBase(body) + BODY.flags] as number) & FLAG.kinematic) !== 0 && state[bodyBase(body) + BODY.role] === ROLE.target);
      expect(first.length, `seed ${seed}`).toBe(1);
      const rounds = (ruleOf(world, 'throw_rounds')!.params as { rounds: { swing?: number[] }[] }).rounds;
      const speeds = [Math.abs(state[bodyBase(first[0]!) + BODY.vx] as number), ...rounds.map((round) => Math.abs(round.swing![4]!))];
      // Rychlost kola = křivka uprostřed kola; roste kolo od kola a nejrychlejší je poslední.
      expect(speeds, `seed ${seed}`).toEqual(speeds.map((_, round) => swingSpeed(intensityAt(Math.floor(((2 * round + 1) * 500) / speeds.length), TENSION_CURVE))));
      for (let round = 1; round < speeds.length; round += 1) expect(speeds[round]!, `seed ${seed}: ${speeds.join(',')}`).toBeGreaterThanOrEqual(speeds[round - 1]!);
      expect(speeds.at(-1)!).toBeGreaterThan(speeds[0]!);
      // Robot: poslední zásah před výhrou je bonusový terč posledního kola (kinematický), a zasáhl každým hodem.
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      expect(bot.outcome).toBe('won');
      let lastHit = -1;
      let throws = 0;
      let hits = 0;
      const program = loadProgram(world, ARCADE_LIBRARY);
      const live = instantiate(world);
      let next = 0;
      for (let tick = 0; tick <= bot.tick && live[HEADER.runState] === 0; tick += 1) {
        while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
        const event = bot.inputs[next];
        step(live, event !== undefined && event.tick === tick ? event : NO_INPUT, program, (rule, effect) => {
          const id = world.rules[rule]!.id;
          if (id === 'launch' && effect.kind === 'spawn') throws += 1;
          if (id === 'shot_hit' && effect.kind === 'despawn') {
            hits += 1;
            lastHit = ((live[bodyBase(effect.body) + BODY.flags] as number) & FLAG.kinematic) !== 0 ? Math.abs(live[bodyBase(effect.body) + BODY.vx] as number) : 0;
          }
        });
      }
      expect(lastHit, `seed ${seed}`).toBe(speeds.at(-1));
      expect(hits).toBe(throws);
    }
  });

  it('a game stored before pacing (genre.v1) builds exactly as without the records', () => {
    for (const cell of CELLS) {
      const spec = storedOf(cellSpec(cell.id));
      const generator = generatorOf(spec);
      const record = GENRE_PACING[generator];
      const before = worldOf(spec);
      try {
        delete GENRE_PACING[generator];
        expect(worldOf(spec), cell.id).toEqual(before);
      } finally {
        if (record !== undefined) GENRE_PACING[generator] = record;
      }
      expect(chain(before.control).map((ref) => ref.id)).not.toContain('pacing_control');
    }
  });

  // Odchylka T14: přistání má jeden život a trvá 13,6–15,1 s (robot intermediate, 20 semínek) – délku 30–90 s průběh nedá.
  it('landing stays unpaced: it builds exactly the world it had before pacing', () => {
    const spec = cellSpec('voyage.land');
    expect(GENRE_PACING.voyage_land).toBeUndefined();
    // Tatáž hra přeložená před háčky P66 (`genre.v5`): `genre.v6` k ní přidá jen počítadlo a pravidlo háčků (T10).
    const preHooks = { ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v5' } };
    for (const seed of SEEDS) expect(worldOf(preHooks, seed), `seed ${seed}`).toEqual(worldOf(storedOf(spec), seed));
  });

  it('no finale adds a win rule or a win wrapper: the paced rules are the stored ones plus pacing, and pacing never wins', () => {
    for (const cell of PACED) {
      const spec = cellSpec(cell.id);
      const paced = worldOf(spec);
      const stored = worldOf(storedOf(spec));
      // Pravidlo `hooks` (P66 T10, létající skóre) nic nevystřelí, takže ani nevyhraje – patří k průběhu nové hry.
      expect(paced.rules.map((rule) => rule.id).filter((id) => id !== 'pacing' && id !== 'hooks'), cell.id).toEqual(stored.rules.map((rule) => rule.id));
      const mine = paced.rules.findIndex((rule) => rule.id === 'pacing');
      const bot = runBot(paced, ARCADE_LIBRARY, { profile: 'intermediate' });
      const winners = new Set<number>();
      const program = loadProgram(paced, ARCADE_LIBRARY);
      const state = instantiate(paced);
      let next = 0;
      for (let tick = 0; tick < bot.tick + 1 && state[HEADER.runState] === 0; tick += 1) {
        while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
        const event = bot.inputs[next];
        step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program, (rule, effect) => {
          if (effect.kind === 'win') winners.add(rule);
        });
      }
      expect(bot.outcome, cell.id).toBe('won');
      expect(winners.size, cell.id).toBeGreaterThan(0);
      expect(winners.has(mine), cell.id).toBe(false);
    }
  });
});
