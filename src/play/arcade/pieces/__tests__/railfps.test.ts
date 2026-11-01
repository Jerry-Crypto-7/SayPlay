/**
 * Jádro střelnice z očí (P68-F T2): kvantované natočení, zásah po sektorech, řádky výšky, vlny, konec.
 *
 * Hlídá to, co by hru tiše změnilo a na pohled by to nikdo nepoznal: střed jako osa 0 (relace ji nezapíše), rána
 * dřív, než natočení dorazí, zásah mimo sektor, výhra před poslední vlnou, náhoda mimo `createCompileRng`.
 * Ručně stavěné světy mají rozvrh vln přepsaný v pravidle `railfps_round` (zbytek je svět generátoru `railfps_rail`),
 * takže každý test ví přesně, co kde stojí.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { RAILFPS_AXES } from '../../../genre/p68-contract';
import { type ArcadeEffect, type ArcadeInput, type ArcadeWorld, BODY, BUTTON, COUNTER, HEADER, NO_INPUT, START_LIVES, bodyBase, bodyHp, type ModeParts } from '../../contract';
import { type HookEffect, isHookEffect } from '../../hooks/contract';
import { completeHooks, hooksOf, roundOf } from '../../hooks';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import {
  RAILFPS,
  RAILFPS_BODIES,
  RAILFPS_SPAWN_SLOTS,
  type RailfpsArrival,
  type RailfpsControlParams,
  type RailfpsRoundParams,
  YAW,
  axisToSector,
  bossSpeedOf,
  checkRailfpsLevel,
  enemySpeedAt,
  foeDistance,
  foeSector,
  foesOf,
  isAlive,
  isEnemy,
  railfpsBodies,
  railfpsControl,
  railfpsRail,
  rayDistance,
  rayPoint,
  sameKind,
  sectorOf,
  sectorToAxis,
  shotOf,
  walkTicks,
  yawStepOf,
} from '../railfps';

const KEEPER = RAILFPS_BODIES.keeper;
const { target: T, enemy: E, boss: B } = RAILFPS_BODIES;

// ---------------------------------------------------------------------------
// Svět a běh

function partsOf(seed: number, params: object = {}): ModeParts {
  return railfpsRail.parts(seed, railfpsRail.params.parse(params), undefined);
}

function build(parts: ModeParts, seed = 1): ArcadeWorld {
  const built = buildWorld({ seed, control: parts.control, rules: completeHooks(parts.rules), bot: parts.bot, level: parts.level, health: parts.health ?? START_LIVES }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Svět generátoru na semínku `seed`; úroveň musí projít kontrolou hratelnosti. */
function worldOf(seed: number, params: object = {}): ArcadeWorld {
  const parts = partsOf(seed, params);
  expect(parts.issues ?? []).toEqual([]);
  return build(parts, seed);
}

/** Svět generátoru s ručním rozvrhem vln (kola háčků = počet vln, 2–5). */
function customWorld(waves: readonly (readonly RailfpsArrival[])[]): ArcadeWorld {
  const parts = partsOf(1, { waves: waves.length });
  const rules = parts.rules.map((ref) => (ref.id === 'railfps_round' ? { id: ref.id, params: { ...ref.params, waves } } : ref));
  return build({ ...parts, rules });
}

const scheduleOf = (world: ArcadeWorld): readonly (readonly RailfpsArrival[])[] => (world.rules.find((ref) => ref.id === 'railfps_round')!.params as RailfpsRoundParams).waves;

interface Session {
  readonly state: Int32Array;
  readonly log: { readonly tick: number; readonly effects: readonly ArcadeEffect[] }[];
  tick(input?: ArcadeInput): readonly ArcadeEffect[];
}

function session(world: ArcadeWorld): Session {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const log: Session['log'] = [];
  return {
    state,
    log,
    tick: (input = NO_INPUT) => {
      const tick = state[HEADER.tick] as number;
      const effects = step(state, input, program);
      log.push({ tick, effects });
      return effects;
    },
  };
}

const aim = (sector: number): ArcadeInput => ({ buttons: 0, axis: sectorToAxis(sector) });
const fire = (sector: number): ArcadeInput => ({ buttons: BUTTON.FIRE, axis: sectorToAxis(sector) });
const despawned = (effects: readonly ArcadeEffect[]): number[] => effects.flatMap((effect) => (effect.kind === 'despawn' ? [effect.body] : []));
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;
/** Živé těleso v sektoru (ruční světy mají v sektoru nejvýš jedno). */
const inSector = (state: Int32Array, sector: number): number => foesOf(state).find((body) => foeSector(state, body) === sector)!;
const hookEvents = (run: Session, kind: HookEffect['kind']): { readonly tick: number; readonly event: HookEffect }[] =>
  run.log.flatMap(({ tick, effects }) => effects.filter((effect): effect is HookEffect => isHookEffect(effect) && effect.kind === kind).map((event) => ({ tick, event })));

/**
 * Hráč testu (ne robot T3): bez reakce míří na nepřítele, který dojde nejdřív, pak na nejbližší terč, a drží `FIRE`.
 * Rozhoduje jen ze stavu jádra.
 */
function greedy(world: ArcadeWorld): (state: Int32Array) => ArcadeInput {
  const { speeds, hooks } = world.control.params as RailfpsControlParams;
  return (state) => {
    const foes = foesOf(state);
    if (foes.length === 0) return NO_INPUT;
    const speed = speeds[Math.min(speeds.length - 1, roundOf(state, hooks))] as number;
    const eta = (body: number): number => {
      if (!isEnemy(state, body)) return Number.MAX_SAFE_INTEGER;
      return Math.ceil((foeDistance(state, body) - RAILFPS.reach) / (sameKind(state, body, RAILFPS_BODIES.boss) ? bossSpeedOf(speed) : speed));
    };
    const pick = [...foes].sort((a, b) => eta(a) - eta(b) || foeDistance(state, a) - foeDistance(state, b) || a - b)[0] as number;
    return fire(foeSector(state, pick));
  };
}

function playOut(world: ArcadeWorld, choose: (state: Int32Array) => ArcadeInput): Session {
  const run = session(world);
  for (let t = 0; t < 5400 && outcomeOf(run.state) === 'running'; t += 1) run.tick(choose(run.state));
  return run;
}

/** Tichý svět: v každé vlně jeden terč daleko vpravo – kolo běží, dokud ho nikdo nesestřelí. */
const QUIET: RailfpsArrival[][] = [[[1, T, 4, 2, 15_000]], [[1, T, -4, 0, 15_000]]];

// ---------------------------------------------------------------------------

describe('railfps axis and quantized yaw (P68-F T2)', () => {
  it('axisToSector and sectorToAxis are inverse on all nine sectors, the center travels as axis 1, never 0', () => {
    expect(YAW.sectors).toBe(9);
    expect(YAW.stepDeg).toBe(15);
    for (let s = -YAW.maxSector; s <= YAW.maxSector; s += 1) {
      const axis = sectorToAxis(s);
      expect(axis, `sector ${String(s)}`).not.toBe(0);
      expect(axis, `sector ${String(s)}`).toBe(s === 0 ? 1 : 250 * s);
      expect(axisToSector(axis), `sector ${String(s)}`).toBe(s);
      // Mimo střed hodnota frozen mřížky P68-I: sektor s = krok 4s.
      if (s !== 0) expect(axis).toBe(RAILFPS_AXES[4 * s + 16]);
    }
    expect(axisToSector(1)).toBe(0);
    expect(axisToSector(-1000)).toBe(-YAW.maxSector);
    expect(axisToSector(1000)).toBe(YAW.maxSector);
  });

  it('the center axis turns the view back to the middle (axis 0 would be no input and the view would stay put)', () => {
    const run = session(customWorld(QUIET));
    run.tick(aim(3));
    for (let t = 1; t < 3 * YAW.turnTicks; t += 1) run.tick();
    expect(yawStepOf(run.state, KEEPER)).toBe(3 * YAW.stepsPerSector);
    run.tick(aim(0));
    for (let t = 1; t < 3 * YAW.turnTicks; t += 1) run.tick();
    expect(yawStepOf(run.state, KEEPER)).toBe(0);
  });

  it('a turn from sector -4 to +4 takes exactly 8 × turnTicks ticks, one step per tick; LEFT / RIGHT move the goal one sector', () => {
    const run = session(customWorld(QUIET));
    run.tick(aim(-YAW.maxSector));
    for (let t = 0; t < 100 && yawStepOf(run.state, KEEPER) !== -16; t += 1) run.tick();
    expect(yawStepOf(run.state, KEEPER)).toBe(-16);
    run.tick(aim(YAW.maxSector));
    const path = [yawStepOf(run.state, KEEPER)];
    for (let t = 0; t < 100 && yawStepOf(run.state, KEEPER) !== 16; t += 1) {
      run.tick();
      path.push(yawStepOf(run.state, KEEPER));
    }
    expect(path).toHaveLength(8 * YAW.turnTicks);
    expect(path).toEqual(Array.from({ length: 32 }, (_, k) => k - 15));
    // ~0,5 s simulace na celý oblouk.
    expect(8 * YAW.turnTicks).toBeGreaterThanOrEqual(24);
    expect(8 * YAW.turnTicks).toBeLessThanOrEqual(40);

    run.tick({ buttons: BUTTON.LEFT, axis: 0 });
    for (let t = 1; t < YAW.turnTicks + 2; t += 1) run.tick();
    expect(yawStepOf(run.state, KEEPER)).toBe(16 - YAW.stepsPerSector);
  });
});

describe('railfps sector hitscan (P68-F T2)', () => {
  it('a latched shot fires only when the turn arrives, and hits the target in the goal sector, not the one passed on the way', () => {
    const run = session(customWorld([[[1, T, 3, 1, 10_000], [1, T, 0, 1, 9_000]], QUIET[1] as RailfpsArrival[]]));
    run.tick();
    const goal = inSector(run.state, 3);
    const center = inSector(run.state, 0);
    // Jeden ťuk (FIRE + osa) – dál žádný vstup; západka čeká na doraz.
    const shots: (number | null)[] = [];
    const hits: number[][] = [];
    for (let t = 0; t < 3 * YAW.turnTicks + 4; t += 1) {
      hits.push(despawned(run.tick(t === 0 ? fire(3) : NO_INPUT)));
      shots.push(shotOf(run.state, KEEPER));
    }
    const arrival = 3 * YAW.turnTicks - 1;
    expect(shots.findIndex((shot) => shot !== null)).toBe(arrival);
    expect(shots.filter((shot) => shot !== null)).toEqual([3]);
    expect(hits.findIndex((list) => list.length > 0)).toBe(arrival);
    expect(hits[arrival]).toEqual([goal]);
    expect(isAlive(run.state, goal)).toBe(false);
    expect(isAlive(run.state, center)).toBe(true);
    expect(score(run.state)).toBe(RAILFPS.points.target);
  });

  it('a shot into an empty sector hits nothing', () => {
    const run = session(customWorld([[[1, T, 3, 1, 10_000], [1, T, 0, 1, 9_000], [1, T, -4, 0, 12_000]], QUIET[1] as RailfpsArrival[]]));
    run.tick();
    const before = foesOf(run.state);
    const effects: ArcadeEffect[] = [];
    let shot: number | null = null;
    for (let t = 0; t < 4 * YAW.turnTicks; t += 1) {
      effects.push(...run.tick(t === 0 ? fire(-2) : NO_INPUT));
      shot ??= shotOf(run.state, KEEPER);
    }
    expect(shot).toBe(-2);
    expect(despawned(effects)).toEqual([]);
    expect(effects.some((effect) => effect.kind === 'score' || effect.kind === 'hit')).toBe(false);
    expect(foesOf(run.state)).toEqual(before);
    expect(score(run.state)).toBe(0);
  });

  it('a target in another sector than the yaw stays untouched, even in the same height row and nearer', () => {
    const run = session(customWorld([[[1, T, 2, 1, 12_000], [1, T, -2, 1, 8_000]], QUIET[1] as RailfpsArrival[]]));
    run.tick();
    const aimed = inSector(run.state, 2);
    const other = inSector(run.state, -2);
    expect(run.state[bodyBase(aimed) + BODY.y]).toBe(run.state[bodyBase(other) + BODY.y]);
    expect(foeDistance(run.state, other)).toBeLessThan(foeDistance(run.state, aimed));
    const hits: number[] = [];
    for (let t = 0; t < 3 * YAW.turnTicks; t += 1) hits.push(...despawned(run.tick(t === 0 ? fire(2) : NO_INPUT)));
    expect(hits).toEqual([aimed]);
    expect(isAlive(run.state, other)).toBe(true);
  });

  it('every sector ray stays in its own sector over the whole shooting band, and spawned things read back their sector', () => {
    for (let s = -YAW.maxSector; s <= YAW.maxSector; s += 1) {
      for (let distance = RAILFPS.reach + 1; distance <= RAILFPS.range; distance += 250) {
        const at = rayPoint(s, distance);
        expect(sectorOf(at.x, at.z), `sector ${String(s)} at ${String(distance)}`).toBe(s);
        // Tabulky sin/cos × 1000 mají chybu pod 0,03 %.
        expect(Math.abs(rayDistance(s, at.x, at.z) - distance)).toBeLessThanOrEqual(2 + Math.ceil(distance / 3000));
      }
    }
    const run = session(customWorld(Array.from({ length: 2 }, () => Array.from({ length: 9 }, (_, n): RailfpsArrival => [1, T, n - 4, n % 3, RAILFPS.reach + 500 + n * 2_500]))));
    run.tick();
    expect(foesOf(run.state).map((body) => foeSector(run.state, body))).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
  });

  it('the boss of the last wave takes bossHp shots; only the last one scores and removes it', () => {
    const run = session(customWorld([QUIET[0] as RailfpsArrival[], [[1, B, 0, 0, 20_000], [1, T, -4, 0, 15_000]]]));
    run.tick();
    const first = inSector(run.state, 4);
    for (let t = 0; t < 40 && isAlive(run.state, first); t += 1) run.tick(fire(4));
    for (let t = 0; t < 200 && hookEvents(run, 'round_start').length < 2; t += 1) run.tick();
    run.tick();
    const boss = inSector(run.state, 0);
    expect(sameKind(run.state, boss, B)).toBe(true);
    expect(bodyHp(run.state, boss)).toBe(RAILFPS.bossHp);
    let shots = 0;
    const scoreBefore = score(run.state);
    for (let t = 0; t < 200 && isAlive(run.state, boss); t += 1) {
      run.tick(fire(0));
      if (shotOf(run.state, KEEPER) === 0) shots += 1;
    }
    expect(shots).toBe(RAILFPS.bossHp);
    expect(score(run.state) - scoreBefore).toBe(RAILFPS.points.boss);
  });
});

describe('railfps pressure, lives and ending (P68-F T2)', () => {
  it('an enemy reaching the player takes a life and disappears; three lives gone = lose', () => {
    const arrivals: RailfpsArrival[] = [[1, E, -3, 0, 6_000], [30, E, 0, 0, 6_000], [60, E, 3, 0, 6_000]];
    const run = session(customWorld([arrivals, QUIET[1] as RailfpsArrival[]]));
    expect(health(run.state)).toBe(START_LIVES);
    expect(START_LIVES).toBe(3);
    const losses: { tick: number; gone: number[] }[] = [];
    for (let t = 0; t < 400 && outcomeOf(run.state) === 'running'; t += 1) {
      const before = health(run.state);
      const effects = run.tick();
      if (health(run.state) < before) {
        expect(before - health(run.state)).toBe(1);
        losses.push({ tick: t, gone: despawned(effects) });
      }
    }
    // Příchod na hodinách kola `at` vznikne v tiku `at − 1`, pak jde nepřítel po paprsku o rychlost kola za tik.
    expect(losses.map((loss) => loss.tick)).toEqual(arrivals.map(([at, , , , distance]) => at - 1 + walkTicks(distance, enemySpeedAt(0))));
    for (const loss of losses) expect(loss.gone).toHaveLength(1);
    expect(health(run.state)).toBe(0);
    expect(outcomeOf(run.state)).toBe('lost');
    expect(run.log.at(-1)!.tick).toBe(losses[2]!.tick);
  });

  it('clearing a wave before the last only ends the round; the win comes after the last wave is cleared, not before', () => {
    const run = session(customWorld([[[1, T, 1, 1, 9_000]], [[1, T, -1, 1, 9_000]]]));
    run.tick();
    const first = inSector(run.state, 1);
    for (let t = 0; t < 60 && isAlive(run.state, first); t += 1) run.tick(fire(1));
    expect(isAlive(run.state, first)).toBe(false);
    // Kolo 1 vyčištěné: přestávka a další kolo, žádná výhra.
    for (let t = 0; t < 300 && hookEvents(run, 'round_start').length < 2; t += 1) {
      run.tick();
      expect(outcomeOf(run.state)).toBe('running');
    }
    expect(hookEvents(run, 'round_clear').map(({ event }) => (event as { round: number }).round)).toEqual([0]);
    run.tick();
    expect(outcomeOf(run.state)).toBe('running');
    const last = inSector(run.state, -1);
    let hitAt = -1;
    for (let t = 0; t < 60 && outcomeOf(run.state) === 'running'; t += 1) {
      const effects = run.tick(fire(-1));
      if (despawned(effects).includes(last)) hitAt = run.log.at(-1)!.tick;
      else if (hitAt < 0) expect(outcomeOf(run.state)).toBe('running');
    }
    expect(hitAt).toBeGreaterThan(0);
    expect(outcomeOf(run.state)).toBe('won');
    // Rána (pravidlo stisku) srazí poslední terč dřív, než pravidlo kola spočítá živé: výhra padne v tomtéž tiku.
    expect(run.log.at(-1)!.tick).toBe(hitAt);
    expect(hookEvents(run, 'round_clear').map(({ event }) => (event as { round: number }).round)).toEqual([0, 1]);
  });

  it('on generated levels a quick player wins only after the last wave; an idle player loses', () => {
    for (const seed of [1, 2, 3]) {
      const world = worldOf(seed);
      const waves = scheduleOf(world).length;
      const run = playOut(world, greedy(world));
      expect(outcomeOf(run.state), `seed ${String(seed)}`).toBe('won');
      expect(hookEvents(run, 'round_start').map(({ event }) => (event as { round: number }).round)).toEqual(Array.from({ length: waves }, (_, k) => k));
      const lastStart = hookEvents(run, 'round_start').at(-1)!.tick;
      expect(run.log.at(-1)!.tick).toBeGreaterThan(lastStart);
      expect(foesOf(run.state)).toEqual([]);
      expect(run.log.at(-1)!.tick).toBeLessThan(5400);
      expect(replay(world, [], ARCADE_LIBRARY).outcome, `seed ${String(seed)} idle`).toBe('lost');
    }
  });
});

describe('railfps level and generator (P68-F T2)', () => {
  const level = { bodies: railfpsBodies(), length: 0, spawnSlots: RAILFPS_SPAWN_SLOTS };

  it('checkRailfpsLevel accepts the generated level and rejects a hand-broken one', () => {
    const waves = scheduleOf(worldOf(1));
    expect(checkRailfpsLevel(level, waves)).toEqual([]);
    const edit = (k: number, n: number, change: (entry: RailfpsArrival) => RailfpsArrival) =>
      waves.map((wave, w) => wave.map((entry, i) => (w === k && i === n ? change(entry) : entry)));
    expect(checkRailfpsLevel(level, edit(0, 0, ([at, from, , row, distance]) => [at, from, 5, row, distance])).join('\n')).toMatch(/sector 5/);
    expect(checkRailfpsLevel(level, edit(0, 0, ([at, from, sector, , distance]) => [at, from, sector, 3, distance])).join('\n')).toMatch(/row 3/);
  });

  it('checkRailfpsLevel rejects a wave with no time to turn between two enemies, and accepts the same wave without the turn', () => {
    // Dva nepřátelé naráz, 60 tiků od hráče: první stihne reakce + otočka přes celý oblouk, druhý na opačném kraji ne.
    const distance = RAILFPS.reach + 60 * enemySpeedAt(0);
    const rest: RailfpsArrival[] = [[1, T, 0, 1, 9_000]];
    const opposite = [[[1, E, -4, 0, distance], [1, E, 4, 0, distance]] as RailfpsArrival[], rest];
    const same = [[[1, E, -4, 0, distance], [1, E, -4, 0, distance]] as RailfpsArrival[], rest];
    expect(checkRailfpsLevel(level, opposite).join('\n')).toMatch(/wave 1: enemy 2 reaches the player/);
    expect(checkRailfpsLevel(level, same)).toEqual([]);
  });

  it('the generator builds playable levels at every bound and every target sits in a sector -4..4 and a row 0..2', () => {
    for (const targets of [RAILFPS.targets.min, RAILFPS.targets.default, RAILFPS.targets.max]) {
      for (const waves of [RAILFPS.waves.min, RAILFPS.waves.default, RAILFPS.waves.max]) {
        for (const seed of [1, 2, 3]) {
          const what = `targets ${String(targets)}, waves ${String(waves)}, seed ${String(seed)}`;
          const parts = partsOf(seed, { targets, waves });
          expect(parts.issues, what).toEqual([]);
          const schedule = (parts.rules.find((ref) => ref.id === 'railfps_round')!.params as RailfpsRoundParams).waves;
          expect(schedule, what).toHaveLength(waves);
          for (const [, from, sector, row] of schedule.flat()) {
            expect(Math.abs(sector)).toBeLessThanOrEqual(YAW.maxSector);
            expect(row).toBeGreaterThanOrEqual(0);
            expect(row).toBeLessThanOrEqual(from === T ? 2 : 0);
          }
          // Boss jen jednou, na konci poslední vlny.
          expect(schedule.flat().filter(([, from]) => from === B)).toHaveLength(1);
          expect(schedule.at(-1)!.at(-1)![1]).toBe(B);
          expect(hooksOf(parts.rules)!.rounds).toBe(waves);
          build(parts, seed);
        }
      }
    }
    expect(railfpsRail.params.safeParse({ targets: RAILFPS.targets.max + 1 }).success).toBe(false);
    expect(railfpsRail.params.safeParse({ waves: RAILFPS.waves.min - 1 }).success).toBe(false);
    expect(ARCADE_LIBRARY.controls.railfps).toBe(railfpsControl);
  });

  it('the same seed builds the same level, another seed another one', () => {
    expect(canonicalHash(worldOf(3))).toBe(canonicalHash(worldOf(3)));
    expect(JSON.stringify(scheduleOf(worldOf(3)))).toBe(JSON.stringify(scheduleOf(worldOf(3))));
    expect(JSON.stringify(scheduleOf(worldOf(3)))).not.toBe(JSON.stringify(scheduleOf(worldOf(4))));
  });

  it('the railfps sources import no three.js, React Three or components and call no wall clock or global random', () => {
    const dir = join(process.cwd(), 'src/play/arcade/pieces');
    const files = readdirSync(dir).filter((name) => /^railfps.*\.ts$/.test(name));
    expect(files).toEqual(expect.arrayContaining(['railfps.ts', 'railfps-world.ts', 'railfps-level.ts', 'railfps-bot.ts']));
    for (const name of files) {
      const source = readFileSync(join(dir, name), 'utf8');
      const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
      for (const path of imports) expect(path, `${name} imports ${path}`).not.toMatch(/^three(\/|$)|@react-three\/|(^|\/)components\//);
      expect(source, name).not.toMatch(/Math\.random|Date\.now|performance\.now/);
    }
  });
});
