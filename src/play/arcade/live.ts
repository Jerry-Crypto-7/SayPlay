/**
 * Živá změna běžící arkády (P29D T7): věta uprostřed hry → záznam
 * `{tick, patch}` ve vstupním logu relace.
 *
 * Jádro (`kernel.ts`) se nemění. Patch se v tiku, na který padl, promění
 * v existující `ArcadeEffect` (`spawn`, `count`) a ty vydá jednorázové
 * pravidlo `tick` přidané k programu jen pro ten jeden krok – efekty tak
 * aplikuje jádro samo, stejnou cestou jako efekty pravidel. Prodloužení času
 * přepíše parametr pravidla `time_limit` v programu od toho tiku dál.
 *
 * `replayLive` přehraje tytéž záznamy, takže replay i hash platí; bez patchů
 * je to přesně `replay` z jádra. Vizuální patch (počasí, denní doba) do stavu
 * nesahá, žije jen v logu (`visualAt`).
 *
 * Co živě nejde (nová role, nové ovládání), sem nepatří – jde to remixem na
 * novou verzi (`director/live-intent.ts`).
 */

import {
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeRole,
  type ArcadeState,
  type ArcadeWorld,
  BODY,
  BODY_STRIDE,
  COUNTER,
  COUNTED_ROLES,
  type CountedRole,
  FLAG,
  HEADER,
  HEADER_SIZE,
  type InputEvent,
  NO_INPUT,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
} from './contract';
import { type ArcadeLibrary, type ArcadeProgram, type ReplayResult, hashArcade, instantiate, loadProgram, outcomeOf, step } from './kernel';
import { ARCADE_LIBRARY } from './library';
import type { GameSpecV1 } from '../spec';

import { TIMES_OF_DAY, type TimeOfDay, WEATHERS, type Weather } from './look';

export { TIMES_OF_DAY, WEATHERS, type TimeOfDay, type Weather };

/** Čítače, které jde živě přidat: životy, sekundy časového limitu, náboje. */
export type LiveCounter = 'health' | 'time' | 'ammo';

export type LivePatch =
  | { readonly kind: 'spawn'; readonly role: ArcadeRole; readonly count: number }
  | { readonly kind: 'count'; readonly counter: LiveCounter; readonly amount: number }
  | { readonly kind: 'visual'; readonly weather?: Weather; readonly timeOfDay?: TimeOfDay };

export interface LiveEntry {
  /** Tik, ve kterém se patch aplikuje (před jeho přičtením). */
  readonly tick: number;
  readonly patch: LivePatch;
}

/** Stav a program běhu; program se mění prodloužením času, stav růstem kvůli novým tělům. */
export interface LiveRun {
  state: ArcadeState;
  program: ArcadeProgram;
}

/** Role, které jde živě přidat: hrozby a sběr. Hráč, cíl, střela ani terč ne. */
const SPAWNABLE: ReadonlySet<ArcadeRole> = new Set(['enemy', 'obstacle', 'hazard', 'collectible', 'chaser']);
const MAX_SPAWN = 5;
const LIMITS: Readonly<Record<LiveCounter, number>> = { health: 3, time: 30, ammo: 20 };
/** Nové tělo nesmí vzniknout hráči pod nohama: aspoň 5 m od něj (u trati před ním). */
const CLEARANCE = 5 * UNIT;

const S = BODY;
const alive = (state: ArcadeState, index: number): boolean => ((state[bodyBase(index) + S.flags] as number) & FLAG.alive) !== 0;
const roleAt = (state: ArcadeState, index: number): number => state[bodyBase(index) + S.role] as number;

/** Hlavní hrozba světa – na ni míří „více nepřátel“: nepřítel, pronásledovatel, nebezpečí, překážka. */
export function hostileRole(state: ArcadeState): ArcadeRole | null {
  const count = state[HEADER.bodyCount] as number;
  for (const role of ['enemy', 'chaser', 'hazard', 'obstacle'] as const) {
    for (let i = 0; i < count; i += 1) if (roleAt(state, i) === ROLE[role]) return role;
  }
  return null;
}

/** Důvod, proč patch v tomhle běhu nejde; `null` = jde. Anglicky – čte ho hráč. */
export function patchProblem(world: ArcadeWorld, state: ArcadeState, patch: LivePatch): string | null {
  if (patch.kind === 'visual') return patch.weather === undefined && patch.timeOfDay === undefined ? 'Nothing to change.' : null;
  if (patch.kind === 'spawn') {
    if (!SPAWNABLE.has(patch.role)) return `A new ${patch.role} cannot join a running game.`;
    if (!Number.isInteger(patch.count) || patch.count < 1 || patch.count > MAX_SPAWN) return `Add 1 to ${MAX_SPAWN} at a time.`;
    const count = state[HEADER.bodyCount] as number;
    let present = false;
    for (let i = 0; i < count && !present; i += 1) present = roleAt(state, i) === ROLE[patch.role];
    if (!present) return `This game has no ${patch.role} to add more of.`;
    return null;
  }
  if (!Number.isInteger(patch.amount) || patch.amount < 1 || patch.amount > LIMITS[patch.counter]) return `Add 1 to ${LIMITS[patch.counter]} at a time.`;
  if (patch.counter === 'health' && !world.rules.some((rule) => rule.id === 'out_of_health')) return 'This game has no lives.';
  if (patch.counter === 'time' && !world.rules.some((rule) => rule.id === 'time_limit')) return 'This game has no clock.';
  if (patch.counter === 'ammo' && (state[HEADER.counters + COUNTER.ammo] as number) + (state[HEADER.counters + COUNTER.reserve] as number) <= 0) return 'This game has no ammo.';
  return null;
}

/** Stav s místem pro `extra` nových těl: volné mrtvé sloty od `spawnBase`, jinak delší pole (nuly = mrtvá těla). */
function withRoom(state: ArcadeState, extra: number): ArcadeState {
  const count = state[HEADER.bodyCount] as number;
  let free = (state.length - HEADER_SIZE) / BODY_STRIDE - count;
  for (let i = state[HEADER.spawnBase] as number; i < count; i += 1) if (!alive(state, i)) free += 1;
  if (free >= extra) return state;
  const capacity = Math.min(ARCADE_LIMITS.maxBodies, (state.length - HEADER_SIZE) / BODY_STRIDE + extra - free);
  const grown = new Int32Array(HEADER_SIZE + capacity * BODY_STRIDE);
  grown.set(state);
  return grown;
}

/**
 * Efekty `spawn`: kopie živých těl role. Na trati (délka > 0) kus za tělem,
 * které je před hráčem; v aréně zrcadlově přes střed. Pozice, která by
 * padla hráči pod nohy nebo za cíl, se přeskočí.
 */
function spawnEffects(world: ArcadeWorld, state: ArcadeState, role: ArcadeRole, count: number): ArcadeEffect[] {
  const bodies = state[HEADER.bodyCount] as number;
  const player = bodyBase(state[HEADER.player] as number);
  const px = state[player + S.x] as number;
  const pz = state[player + S.z] as number;
  const sources: number[] = [];
  for (let i = 0; i < bodies; i += 1) if (roleAt(state, i) === ROLE[role] && alive(state, i)) sources.push(i);
  const effects: ArcadeEffect[] = [];
  const at = (template: number, x: number, z: number): void => {
    if (effects.length >= count) return;
    const base = bodyBase(template);
    effects.push({ kind: 'spawn', template, x, y: state[base + S.y] as number, z, vx: state[base + S.vx] as number, vy: state[base + S.vy] as number, vz: state[base + S.vz] as number });
  };
  if (world.length > 0) {
    const ahead = sources.filter((i) => (state[bodyBase(i) + S.z] as number) >= pz + CLEARANCE).sort((a, b) => (state[bodyBase(a) + S.z] as number) - (state[bodyBase(b) + S.z] as number) || a - b);
    for (let round = 1; round <= MAX_SPAWN && effects.length < count; round += 1) {
      for (const i of ahead) {
        const z = (state[bodyBase(i) + S.z] as number) + round * 3 * UNIT;
        if (z < world.length - CLEARANCE) at(i, state[bodyBase(i) + S.x] as number, z);
      }
    }
    return effects;
  }
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1]] as const) {
    for (const i of sources) {
      const x = sx * (state[bodyBase(i) + S.x] as number);
      const z = sz * (state[bodyBase(i) + S.z] as number);
      if (Math.hypot(x - px, z - pz) >= CLEARANCE) at(i, x, z);
    }
  }
  return effects;
}

/** Jednorázové pravidlo `tick`, které vydá předem spočtené efekty – aplikuje je jádro. */
function burst(effects: readonly ArcadeEffect[]): ArcadeProgram['rules'][number] {
  const piece = {
    id: 'live_patch',
    params: { parse: (input: unknown) => input },
    roles: [],
    trigger: 'tick',
    cost: () => ({ bodies: 0, rules: 0 }),
    fire: () => effects,
  } as unknown as RulePiece;
  return { piece, params: null };
}

/** Program s časovým limitem delším o `seconds` (parametr `time_limit` od tohoto tiku dál). */
function longer(program: ArcadeProgram, seconds: number): ArcadeProgram {
  return {
    ...program,
    rules: program.rules.map((rule) => (rule.piece.id === 'time_limit' ? { ...rule, params: { ...(rule.params as { seconds: number }), seconds: (rule.params as { seconds: number }).seconds + seconds } } : rule)),
  };
}

export function startLive(world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY): LiveRun {
  return { state: instantiate(world), program: loadProgram(world, library) };
}

/**
 * Jeden tik s patchi, které na něj padly. Patch, který v tuhle chvíli nejde
 * (`patchProblem`), se tiše přeskočí – přijímá se jen ověřený (`acceptLive`),
 * takže v logu takový není, a replay i živý běh ho přeskočí stejně.
 */
export function stepLive(world: ArcadeWorld, run: LiveRun, input: ArcadeInput, due: readonly LivePatch[]): readonly ArcadeEffect[] {
  const effects: ArcadeEffect[] = [];
  for (const patch of due) {
    if (patch.kind === 'visual' || patchProblem(world, run.state, patch) !== null) continue;
    if (patch.kind === 'spawn') {
      run.state = withRoom(run.state, patch.count);
      effects.push(...spawnEffects(world, run.state, patch.role, patch.count));
    } else if (patch.counter === 'time') run.program = longer(run.program, patch.amount);
    else effects.push({ kind: 'count', counter: patch.counter satisfies ArcadeCounter, amount: patch.amount });
  }
  const program = effects.length === 0 ? run.program : { ...run.program, rules: [...run.program.rules, burst(effects)] };
  return step(run.state, input, program);
}

/** Patche seřazené podle tiku, rozdělené po ticích – kurzor pro přehrání. */
function cursorOf(patches: readonly LiveEntry[]): (tick: number) => LivePatch[] {
  const sorted = [...patches].sort((a, b) => a.tick - b.tick);
  let next = 0;
  return (tick) => {
    const due: LivePatch[] = [];
    while (next < sorted.length && (sorted[next] as LiveEntry).tick < tick) next += 1;
    while (next < sorted.length && (sorted[next] as LiveEntry).tick === tick) due.push((sorted[next++] as LiveEntry).patch);
    return due;
  };
}

/** Přehraje vstupy i živé změny od tiku 0 – stejný hash jako živý běh; bez patchů = `replay` jádra. */
export function replayLive(world: ArcadeWorld, inputs: readonly InputEvent[], patches: readonly LiveEntry[], library: ArcadeLibrary = ARCADE_LIBRARY, horizon: number = ARCADE_LIMITS.maxTicks): ReplayResult {
  const run = startLive(world, library);
  const dueAt = cursorOf(patches);
  let next = 0;
  for (let tick = 0; tick < horizon && outcomeOf(run.state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    stepLive(world, run, event !== undefined && event.tick === tick ? event : NO_INPUT, dueAt(tick));
  }
  return { hash: hashArcade(run.state), outcome: outcomeOf(run.state), tick: run.state[HEADER.tick] as number };
}

/**
 * Robot ověřovače odehraje hru od tiku 0 se stejnými živými změnami ve
 * stejných ticích (týž tvar jako `runBot` ve `verify.ts`). Stav se může
 * zvětšit, proto se kopie pro zpoždění reakce při růstu dorovnají.
 */
function botWins(world: ArcadeWorld, patches: readonly LiveEntry[], library: ArcadeLibrary): boolean {
  const bot = library.bots[world.bot.id];
  if (bot === undefined) return false;
  const params = bot.params.parse(world.bot.params);
  const run = startLive(world, library);
  const dueAt = cursorOf(patches);
  const delay = bot.reactionTicks;
  let history = Array.from({ length: delay + 1 }, () => run.state.slice());
  const issued: ArcadeInput[] = [];
  const player = run.state[HEADER.player] as number;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(run.state) === 'running'; tick += 1) {
    if ((history[0] as ArcadeState).length !== run.state.length) {
      history = history.map((old) => {
        const grown = new Int32Array(run.state.length);
        grown.set(old);
        return grown;
      });
    }
    (history[tick % (delay + 1)] as ArcadeState).set(run.state);
    const seenAt = Math.max(0, tick - delay);
    const input = bot.decide({ state: history[seenAt % (delay + 1)] as ArcadeState, player, tick: seenAt, recent: issued.slice(issued.length - (tick - seenAt)) }, params);
    issued.push(input);
    stepLive(world, run, input, dueAt(tick));
  }
  return outcomeOf(run.state) === 'won';
}

export type LiveVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Přijme patch v tiku `tick` stavu `state`: musí dávat smysl pro tuhle hru a
 * robot ověřovače musí hru se všemi dosavadními změnami i s touhle pořád
 * vyhrát. Jinak důvod pro hráče.
 */
export function acceptLive(world: ArcadeWorld, state: ArcadeState, log: readonly LiveEntry[], entry: LiveEntry, library: ArcadeLibrary = ARCADE_LIBRARY): LiveVerdict {
  const problem = patchProblem(world, state, entry.patch);
  if (problem !== null) return { ok: false, reason: problem };
  if (entry.patch.kind === 'visual') return { ok: true };
  return botWins(world, [...log, entry], library) ? { ok: true } : { ok: false, reason: 'That change would make the game impossible to win.' };
}

/** Počasí a denní doba platné v tiku `tick` – poslední vizuální patch do něj; bez něj `start` (sdílená verze nese svoje v `theme`). */
export function visualAt(
  patches: readonly LiveEntry[],
  tick: number,
  start: { readonly weather?: Weather; readonly timeOfDay?: TimeOfDay } = {},
): { readonly weather: Weather; readonly timeOfDay: TimeOfDay } {
  let weather: Weather = start.weather ?? 'clear';
  let timeOfDay: TimeOfDay = start.timeOfDay ?? 'day';
  for (const { tick: at, patch } of [...patches].sort((a, b) => a.tick - b.tick)) {
    if (at > tick || patch.kind !== 'visual') continue;
    weather = patch.weather ?? weather;
    timeOfDay = patch.timeOfDay ?? timeOfDay;
  }
  return { weather, timeOfDay };
}

/** Strop počtu role ve specu (`roleSchema.count`). */
const MAX_ROLE_COUNT = 50;

/** Kolik toho generátor na startu hry opravdu postavil: řady (`rows`) nebo těla role. */
function startCountOf(world: ArcadeWorld, counted: CountedRole): number {
  const state = world.initial;
  const zs = new Set<number>();
  let bodies = 0;
  for (let i = 0; i < state[HEADER.bodyCount]; i += 1) {
    const base = bodyBase(i);
    if (state[base + S.role] !== ROLE[counted.role]) continue;
    bodies += 1;
    zs.add(state[base + S.z]);
  }
  return counted.key === 'rows' ? zs.size : bodies;
}

/**
 * Spec sdílené verze s živými změnami (P29D T10): přidaná těla zvednou počet
 * role, který čte generátor ovládání (`COUNTED_ROLES`), poslední počasí a
 * denní doba jdou do `theme`. Počet vychází z toho, co hra na startu opravdu
 * má (`startCountOf`), ne ze specu – `count` 1 tam znamená „neřečeno“ a
 * generátor postaví víc. Čítače (životy, čas, náboje) a přidaná těla, která
 * generátor tohohle ovládání nepočítá, patří jen běhu – jejich počet vrací
 * `dropped`, aby se to hráč dozvěděl.
 *
 * Tady, ne v `director/remix.ts`: volá ji arkáda v prohlížeči, která schémata
 * specu nenese (`arcade-bundle.test.ts`).
 */
export function liveRemixSpec(parent: GameSpecV1, world: ArcadeWorld, patches: readonly LivePatch[]): { readonly spec: GameSpecV1; readonly dropped: number } {
  const child = structuredClone(parent);
  const counted = COUNTED_ROLES[parent.control ?? ''] ?? [];
  const added = new Map<CountedRole, number>();
  let dropped = 0;
  for (const patch of patches) {
    if (patch.kind === 'visual') {
      if (patch.weather !== undefined) child.theme.weather = patch.weather;
      if (patch.timeOfDay !== undefined) child.theme.timeOfDay = patch.timeOfDay;
    }
    if (patch.kind === 'count') dropped += 1;
    if (patch.kind !== 'spawn') continue;
    const entry = counted.find((candidate) => candidate.role === patch.role && child.roles.some((role) => role.id === candidate.roleId));
    if (entry === undefined) dropped += 1;
    else added.set(entry, (added.get(entry) ?? 0) + patch.count);
  }
  for (const [entry, extra] of added) {
    const target = child.roles.find((role) => role.id === entry.roleId)!;
    const from = Math.max(target.count, startCountOf(world, entry));
    const to = Math.min(MAX_ROLE_COUNT, entry.max, from + extra);
    // Hra, která na startu stojí u stropu, víc nepojme – strop by počet naopak snížil.
    if (to > from) target.count = to;
    else dropped += 1;
  }
  // Jasno ve dne je výchozí stav – spec bez pole je táž hra, a tedy týž hash.
  if (child.theme.weather === 'clear') delete child.theme.weather;
  if (child.theme.timeOfDay === 'day') delete child.theme.timeOfDay;
  return { spec: child, dropped };
}
