/**
 * Průběh střelnice, souboje dvou a míče (P45C T13).
 *
 * Střelnice: vlny čekají za branou (mimo dostřel) a vyjdou podle jízdního
 * řádu, jehož rozestupy křivka zhušťuje; ostřelovač (T5) přijde v rozvrhu od
 * druhé vlny a po varování střílí zpět; finále je boss-terč (`turret`) s HP
 * 4–6 a salvou, kterou jde sestřelit – přijde se začátkem poslední vlny a
 * výhra (`cleared`) čeká na jeho pád.
 *
 * Souboj: knoflík agresivity soupeře (`pace`) jde s intenzitou místo zrychlení
 * po soupeřích; finále = rozzuření posledního soupeře pod polovinou HP –
 * delší nápřah (varování) a kratší mezera. Rozzuřený soupeř bez delšího
 * varování by byl „těžší“ jen tím, že je nefér (pin).
 *
 * Míč zůstává bez průběhu: spec staví `nativeSpec` bez `genre` (jako chodec).
 * Odchylka měřidla: soupeř souboje stojí (scéna ho kreslí na startu), tlak
 * hrozeb je tedy 0 – stoupání souboje se měří četností úderů po třetinách.
 * Žádné finále nepřidá výhru ani obal výhry.
 */

import { describe, expect, it } from 'vitest';

import { finaleOf, pressureRun, risingOf } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, generatorOf } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, BODY_STRIDE, FLAG, HEADER, NO_INPUT, type PieceRef, ROLE, UNIT, bodyBase, bodyHp, underlyingRule } from '../contract';
import { instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { type BehaviourRef, TELEGRAPH_MIN, behaviourBodies, behaviourPhaseOf } from '../pieces/behaviours';
import { telegraphCheck, play } from '../pieces/behaviours/__tests__/harness';
import { TURRET } from '../pieces/behaviours/boss';
import { DUEL, DUEL_ENRAGE, DUEL_FOE, DUEL_PHASE, duelControl } from '../pieces/duel';
import { PACING, PACING_KNOBS, scaledParams } from '../pieces/pacing';
import { GENRE_PACING } from '../pieces/pacing-parts';
import { SHOOTER_PACE, SHOOTER_RANGE, shooterGun, waveSpacing } from '../pieces/shooter';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GenreSpec } from '@/play/genre/contract';
import { compileGenre, readGenreSpec } from '@/play/genre';
import type { GameSpecV1 } from '@/play/spec';

const STATIC_A = ['shooter_range', 'duel_arena', 'ball_pitch'];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const CELLS = liveCells().filter((cell) => {
  const spec = compileRecipe(assemblyOfCell(cell));
  return spec.genre !== undefined && STATIC_A.includes(generatorOf(spec));
});
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(CELLS.find((cell) => cell.id === id)!));
/** Hra žánru z věty (výchozí tři životy) – buňka P41 `shooter.default` má jediný život. */
const genreSpec = (genre: string, params: Record<string, unknown> = {}): GameSpecV1 => {
  const read = readGenreSpec({ genre, mode: 'default', hero: 'robot', setting: 'desert', params });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value as GenreSpec);
};
/** Střelnice ze všech vět se třemi životy: finále boss-terč. */
const shooterSpec = (): GameSpecV1 => genreSpec('shooter');
const lastWaveAt = (spec: GameSpecV1): number => {
  const waves = (spec.controlParams as { waves: number }).waves;
  return Math.floor(((waves - 1) * 1000) / waves);
};

const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Tatáž hra uložená před průběhem (`genre.v1`). */
const storedOf = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const ruleOf = (world: ArcadeWorld, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const pacedRefs = (world: ArcadeWorld): readonly BehaviourRef[] => (chain(world.control).find((ref) => ref.id === 'pacing_control')?.params.behaviours ?? []) as BehaviourRef[];
const scheduleOf = (world: ArcadeWorld): { atPermille: number; template: number }[] => (ruleOf(world, 'pacing')!.params as { schedule: { atPermille: number; template: number }[] }).schedule;

/** Údery soupeře souboje (přechod nápřah → mezera) po třetinách běhu. */
function strikesPerThird(world: ArcadeWorld, inputs: Parameters<typeof play>[1]): [number, number, number] {
  const ticks: number[] = [];
  let last = -1;
  const state = play(world, inputs, (now, tick) => {
    const phase = now[bodyBase(DUEL_FOE) + BODY.aux0] as number;
    if (last === DUEL_PHASE.windup && phase === DUEL_PHASE.open) ticks.push(tick);
    last = phase;
  });
  const end = (state[HEADER.tick] as number) + 1;
  const third = (k: number): number => ticks.filter((tick) => tick * 3 >= k * end && tick * 3 < (k + 1) * end).length;
  return [third(0), third(1), third(2)];
}

/** Vlny střelnice jako tiky příchodu k hráči: držené nepřítel vyjde v `at` z brány, ostatní jdou od startu. */
function arrivals(world: ArcadeWorld): number[] {
  const state = instantiate(world);
  const march = (chain(world.control).find((ref) => ref.id === 'shooter')!.params.march ?? []) as { body: number; at: number; vx: number; vz: number }[];
  const out: number[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.enemy || (state[base + BODY.flags]! & 1) === 0) continue;
    const held = march.find((entry) => entry.body === body);
    const z = state[base + BODY.z] as number;
    out.push(held === undefined ? z / -(state[base + BODY.vz] as number) : held.at + z / -held.vz);
  }
  return out.sort((a, b) => a - b);
}

describe('static genres A are paced (shooter and duel; ball stays unpaced)', () => {
  it('covers every live shooter and duel cell with a genre', () => {
    expect(CELLS.map((cell) => cell.id).sort()).toEqual(['duel.default', 'shooter.default']);
  });

  // Živé buňky s průběhem a střelnice z věty se třemi životy; buňka `shooter.default` má jediný život a průběh nedostane.
  const GAMES = [
    ...CELLS.filter((cell) => cell.id !== 'shooter.default').map((cell) => ({ id: cell.id, spec: () => compileRecipe(assemblyOfCell(cell)) })),
    { id: 'shooter (three lives)', spec: shooterSpec },
  ];

  for (const cell of GAMES) {
    it(`${cell.id}: rising, a finale, bot wins 7/8 in 30–90 s, idle loses, replay equal`, () => {
      const spec = cell.spec();
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
        const run = pressureRun(world, bot.inputs);
        expect(run.hash).toBe(bot.hash);
        if (cell.id.startsWith('duel')) {
          // Soupeř stojí (tlak měřidla 0): souboj stoupá četností úderů.
          const strikes = strikesPerThird(world, bot.inputs);
          expect(strikes[2], `${cell.id} seed ${seed}: strikes by thirds ${strikes.join(' / ')}`).toBeGreaterThanOrEqual(strikes[0] * 1.15);
        } else expect(risingOf(run.threatsPerThird), `${cell.id} seed ${seed}: pressure by thirds ${run.threatsPerThird.join(' / ')}`).toBe(true);
        if (bot.outcome === 'won') {
          wins += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeLessThanOrEqual(90);
        }
      }
      expect(wins, `${cell.id}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 600_000);
  }

  it('shooter: the waves wait behind the gate and walk in on a timetable the curve makes denser', () => {
    const spec = shooterSpec();
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const state = instantiate(world);
      const march = chain(world.control).find((ref) => ref.id === 'shooter')!.params.march as { body: number; at: number; vx: number; vz: number }[];
      expect(march.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const entry of march) {
        const base = bodyBase(entry.body);
        // Za branou stojí, mimo dostřel; vyjde rovnou na hráče.
        expect([state[base + BODY.vx], state[base + BODY.vz]]).toEqual([0, 0]);
        expect(state[base + BODY.z]).toBeGreaterThanOrEqual(SHOOTER_PACE.gate);
        expect(entry.vz).toBeLessThan(0);
        expect(entry.at).toBeGreaterThan(0);
      }
      const times = arrivals(world);
      const starts = times.filter((tick, index) => index === 0 || tick - times[index - 1]! > SHOOTER_RANGE.memberGap);
      const gaps = starts.slice(1).map((tick, index) => tick - starts[index]!);
      // Hustota z křivky: poslední rozestup kratší než první, žádný kratší, než vlnu stihne vystřílet i s přebitím.
      expect(gaps.at(-1)!, `seed ${seed}: ${gaps.join(',')}`).toBeLessThan(gaps[0]!);
      const gun = shooterGun({ difficulty: 'normal', moving: true, ...(spec.controlParams as object) } as never);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(waveSpacing(3, gun));
    }
  });

  it('shooter: the sniper comes on the schedule from the second wave, and it fires only after its telegraph', () => {
    const spec = shooterSpec();
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const sniper = pacedRefs(world).find((ref) => ref.id === 'sniper')!;
      expect(sniper, `seed ${seed}`).toBeDefined();
      const state = instantiate(world);
      // Role nepřítele: jde ho sestřelit (projektil hráče končí jen na terči a nepříteli).
      expect(state[bodyBase(sniper.template) + BODY.role]).toBe(ROLE.enemy);
      // Od začátku druhé vlny, nejpozději před poslední (s bossem nepřijde).
      const waves = (spec.controlParams as { waves: number }).waves;
      const own = scheduleOf(world).filter((entry) => entry.template === sniper.template);
      expect(own.length).toBeGreaterThan(0);
      for (const entry of own) {
        expect(entry.atPermille).toBeGreaterThanOrEqual(Math.floor(1000 / waves));
        expect(entry.atPermille).toBeLessThan(lastWaveAt(spec));
      }
      // Každý výstřel, který hráče zasáhl, měl střelce, který předtím aspoň `TELEGRAPH_MIN` tiků varoval.
      const novice = runBot(world, ARCADE_LIBRARY, { profile: 'novice' });
      expect(telegraphCheck(world, novice.inputs).violations, `seed ${seed}`).toEqual([]);
    }
    // Ostřelovač 11 m před hráčem, který nestřílí: varuje (zamčená přímka), pak vystřelí a výstřel zasáhne.
    const world = worldOf(spec);
    const sniper = pacedRefs(world).find((ref) => ref.id === 'sniper')!;
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    let slot = state[HEADER.spawnBase] as number;
    while (slot < (state[HEADER.bodyCount] as number) && (state[bodyBase(slot) + BODY.flags]! & FLAG.alive) !== 0) slot += 1;
    if (slot === state[HEADER.bodyCount]) state[HEADER.bodyCount] = slot + 1;
    state.copyWithin(bodyBase(slot), bodyBase(sniper.template), bodyBase(sniper.template) + BODY_STRIDE);
    state[bodyBase(slot) + BODY.x] = 0;
    state[bodyBase(slot) + BODY.z] = 11 * UNIT;
    state[bodyBase(slot) + BODY.flags] = state[bodyBase(slot) + BODY.flags]! | FLAG.alive;
    let warned = 0;
    let fired = -1;
    let struck = -1;
    for (let tick = 0; tick < 400 && state[HEADER.runState] === 0 && struck < 0; tick += 1) {
      step(state, NO_INPUT, program, (_rule, effect) => {
        if (effect.kind === 'spawn' && effect.template === sniper.shot && fired < 0) fired = tick;
        if (effect.kind === 'damage' && fired >= 0 && struck < 0) struck = tick;
      });
      if (fired < 0 && behaviourPhaseOf(state, slot) === 'telegraph') warned += 1;
    }
    expect(fired).toBeGreaterThan(0);
    expect(warned).toBeGreaterThanOrEqual(TELEGRAPH_MIN);
    expect(struck).toBeGreaterThan(fired);
  });

  // Odchylka T13: s průběhem začátečník vyhrával 0,85–1,0 místo 0,7 (boss i jen poslední vlna) – jeden proniklý výstřel prohraje celou hru.
  it('shooter with one life (the P41 cell) stays unpaced: it builds exactly the world it had before pacing', () => {
    const spec = cellSpec('shooter.default');
    expect((spec.mechanics.find((mechanic) => mechanic.id === 'health')!.params as { max: number }).max).toBe(1);
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(chain(world.control).map((ref) => ref.id)).not.toContain('pacing_control');
      expect(world, `seed ${seed}`).toEqual(worldOf(storedOf(spec), seed));
    }
  });

  it('shooter: the finale is a boss target with 4–6 HP and a salvo that can be shot down; the win waits for its fall', () => {
    const spec = shooterSpec();
    expect((spec.mechanics.find((mechanic) => mechanic.id === 'health')!.params as { max: number }).max).toBeGreaterThan(1);
    const stored = worldOf(storedOf(spec));
    let fallen = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const turret = pacedRefs(world).at(-1)!;
      expect(turret.id).toBe('turret');
      expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('boss');
      const state = instantiate(world);
      const boss = bodyBase(turret.template);
      expect(state[boss + BODY.role]).toBe(ROLE.target);
      expect(bodyHp(state, turret.template)).toBeGreaterThanOrEqual(4);
      expect(bodyHp(state, turret.template)).toBeLessThanOrEqual(6);
      expect(TURRET.shots).toBeGreaterThanOrEqual(2);
      // Salva: výstřely s rolí nepřítele – hráč, který se nehne, je sestřelí.
      expect(state[bodyBase(turret.shot!) + BODY.role]).toBe(ROLE.enemy);
      expect((ruleOf(world, 'boss_beat_hit')!.params as { boss: number }).boss).toBe(turret.template);
      expect(ruleOf(world, 'boss_beat')).toBeUndefined();
      expect((ruleOf(world, 'shot_hit')!.params as { spare?: number }).spare).toBe(turret.template);
      // Přijde se začátkem poslední vlny.
      const waves = (spec.controlParams as { waves: number }).waves;
      expect(scheduleOf(world).find((entry) => entry.template === turret.template)!.atPermille).toBe(Math.floor(((waves - 1) * 1000) / waves));
      // Nepřátel je stejně jako bez průběhu.
      const enemies = (w: ArcadeWorld): number => { const s = instantiate(w); let n = 0; for (let b = 0; b < (s[HEADER.bodyCount] as number); b += 1) if (s[bodyBase(b) + BODY.role] === ROLE.enemy && (s[bodyBase(b) + BODY.flags]! & 1) !== 0) n += 1; return n; };
      expect(enemies(world)).toBe(enemies(stored));
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      let seen = -1;
      let fell = -1;
      play(world, bot.inputs, (now, tick) => {
        const alive = behaviourBodies(now, now[HEADER.player] as number, [turret]).length > 0;
        if (alive && seen < 0) seen = tick;
        if (!alive && seen >= 0 && fell < 0) fell = tick;
      });
      if (bot.outcome === 'won') {
        expect(fell, `seed ${seed}: the win came before the boss fell`).toBeGreaterThanOrEqual(0);
        fallen += 1;
      }
    }
    expect(fallen).toBeGreaterThanOrEqual(7);
  });

  it('duel: the aggression knob follows the intensity instead of the per-rival speed-up', () => {
    const world = worldOf(cellSpec('duel.default'));
    const duel = chain(world.control).find((ref) => ref.id === 'duel')!;
    expect(duel.params.pace).toBe(1000);
    expect(duel.params.rise).toBeUndefined();
    // Úvod pomaleji, stupňování rychleji; vrchol a finále na stropu knoflíku (pod ním mezera po úderu unese reakci začátečníka).
    const cap = PACING_KNOBS.duel![0]!.max;
    expect(scaledParams('duel', duel.params, PACING.intensity.intro).pace).toBe(PACING.intensity.intro);
    expect(scaledParams('duel', duel.params, PACING.intensity.buildUp).pace).toBe(PACING.intensity.buildUp);
    expect(cap).toBeGreaterThan(PACING.intensity.buildUp);
    expect(scaledParams('duel', duel.params, PACING.intensity.finale).pace).toBe(cap);
    expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('round');
  });

  it('duel: the enraged last rival winds up longer and recovers faster than before its enrage (pin)', () => {
    const world = worldOf(cellSpec('duel.default'));
    const params = duelControl.params.parse(chain(world.control).find((ref) => ref.id === 'duel')!.params);
    expect(params.enrage).toEqual(DUEL_ENRAGE);
    const rounds = params.rounds ?? 1;
    /** Nápřah a mezera, které soupeř nastaví po `hits` zásazích hráče (tentýž útok vzorce). */
    const attackAfter = (hits: number, enrage: boolean): { windup: number; recover: number } => {
      const own = enrage ? params : { ...params, enrage: undefined };
      const state = instantiate(world);
      const player = state[HEADER.player] as number;
      const foe = bodyBase(DUEL_FOE);
      state[bodyBase(player) + BODY.z] = hits * UNIT;
      state[HEADER.tick] = DUEL.lead;
      duelControl.step(state, player, NO_INPUT, own);
      const windup = state[foe + BODY.aux1] as number;
      state[foe + BODY.aux1] = 1;
      duelControl.step(state, player, NO_INPUT, own);
      return { windup, recover: state[foe + BODY.aux1] as number };
    };
    const last = params.foeHealth * (rounds - 1);
    const above = last + params.foeHealth - Math.ceil(params.foeHealth / 2);
    const below = last + params.foeHealth - Math.floor((params.foeHealth - 1) / 2);
    // Nad polovinou HP (a s vypnutým rozzuřením i pod ní) útočí stejně.
    expect(attackAfter(above, true)).toEqual(attackAfter(above, false));
    const calm = attackAfter(below, false);
    const enraged = attackAfter(below, true);
    // Delší varování: rozzuřený soupeř bez něj by byl jen nefér.
    expect(enraged.windup).toBe(calm.windup + DUEL_ENRAGE.warn);
    expect(enraged.windup).toBeGreaterThan(calm.windup);
    // Rychlejší útok: kratší mezera, ale nikdy pod reakci robota (`minRecover`).
    expect(enraged.recover).toBeLessThan(calm.recover);
    expect(enraged.recover).toBeGreaterThanOrEqual(DUEL.minRecover);
    // Dřívější soupeř se nerozzuří.
    expect(attackAfter(below - params.foeHealth, true)).toEqual(attackAfter(below - params.foeHealth, false));
  });

  it('a game stored before pacing (genre.v1) builds exactly as without the records', () => {
    for (const cell of GAMES) {
      const spec = storedOf(cell.spec());
      const generator = generatorOf(spec);
      const record = GENRE_PACING[generator];
      const before = worldOf(spec);
      try {
        delete GENRE_PACING[generator];
        expect(worldOf(spec), cell.id).toEqual(before);
      } finally {
        GENRE_PACING[generator] = record;
      }
      expect(chain(before.control).map((ref) => ref.id)).not.toContain('pacing_control');
    }
  });

  it('no finale adds a win rule or a win wrapper: the paced rules are the stored ones plus pacing (and boss_beat_hit), and neither wins', () => {
    for (const cell of GAMES) {
      const spec = cell.spec();
      const paced = worldOf(spec);
      const stored = worldOf(storedOf(spec));
      const own = (id: string): boolean => id === 'pacing' || id === 'boss_beat_hit';
      expect(paced.rules.map((rule) => rule.id).filter((id) => !own(id)), cell.id).toEqual(stored.rules.map((rule) => rule.id));
      const mine = new Set(paced.rules.flatMap((rule, index) => (own(rule.id) ? [index] : [])));
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
      for (const rule of winners) expect(mine.has(rule), `${cell.id}: rule ${paced.rules[rule]!.id} won`).toBe(false);
    }
  });
});

describe('ball modes stay unpaced (P45C T13, deviation)', () => {
  const BALLS = liveCells().filter((cell) => generatorOf(compileRecipe(assemblyOfCell(cell))) === 'ball_pitch');

  it('every ball cell is a native spec without genre: its world has no pacing and only the rules its generator builds', async () => {
    expect(BALLS.map((cell) => cell.id).sort()).toEqual(['ball.defeat', 'ball.score', 'ball.score+rival']);
    const { loadRapier } = await import('../physics/world');
    const { preloadPhysics } = await import('../compile');
    for (const cell of BALLS) {
      const spec = compileRecipe(assemblyOfCell(cell));
      await preloadPhysics(spec, loadRapier);
      expect(spec.genre, cell.id).toBeUndefined();
      const { generator: _generator, ...params } = spec.controlParams as Record<string, unknown>;
      const world = worldOf(spec);
      expect(chain(world.control).map((ref) => ref.id), cell.id).toEqual(['ball']);
      const own = MODE_GENERATORS.ball_pitch!.parts(1, MODE_GENERATORS.ball_pitch!.params.parse(params), undefined);
      expect(world.rules.map((rule) => rule.id).filter((id) => id !== 'time_limit'), cell.id).toEqual(own.rules.map((rule) => rule.id).filter((id) => id !== 'time_limit'));
    }
  });
});
