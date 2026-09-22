/**
 * Arkádové jádro (P25A, T2): `step()`, hash a přehrání.
 *
 * Tik: vstup → ovládání → integrace (rychlost, gravitace) → kolize AABB hráče
 * s ostatními (přistání na horní hraně pevného těla není náraz) → pravidla →
 * úklid. Všechno jsou celá čísla v `Int32Array`; jádro nemá hodiny ani
 * náhodu, takže stav v tiku *t* je funkce počátečního stavu a vstupů 0..*t*.
 * Každá smyčka jde přes těla nebo pravidla světa, a těch je nejvýš
 * `ARCADE_LIMITS` (ohlídá `buildWorld`).
 */

import { hashHex } from '@/sim/hash';

import {
  ARCADE_LIMITS,
  ARCADE_RUNTIME_VERSION,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeLevel,
  type ArcadeState,
  type ArcadeWorld,
  BODY,
  BODY_STRIDE,
  type BotPiece,
  COUNTER,
  type ControlPiece,
  FLAG,
  type GeneratorPiece,
  HEADER,
  HEADER_SIZE,
  type InputEvent,
  NO_INPUT,
  type PieceRef,
  ROLE,
  RUN_STATE,
  type RulePiece,
  bodyBase,
  stateSize,
} from './contract';

/** Gravitace v jednotkách za tik² (8 → ~28,8 m/s², arkádově rychlý dopad). */
export const GRAVITY = 8;

export interface ArcadeLibrary {
  readonly controls: Readonly<Record<string, ControlPiece>>;
  readonly rules: Readonly<Record<string, RulePiece>>;
  readonly generators: Readonly<Record<string, GeneratorPiece>>;
  readonly bots: Readonly<Record<string, BotPiece>>;
}

interface Bound<T> {
  readonly piece: T;
  readonly params: unknown;
}

/** Kusy světa, už vyhledané v knihovně a s přečtenými parametry. */
export interface ArcadeProgram {
  readonly control: Bound<ControlPiece>;
  readonly rules: readonly Bound<RulePiece>[];
}

export type ArcadeOutcome = 'running' | 'won' | 'lost';

function bind<T extends { readonly params: { parse(input: unknown): unknown } }>(table: Readonly<Record<string, T>>, ref: PieceRef, what: string): Bound<T> {
  const piece = table[ref.id];
  if (piece === undefined) throw new Error(`arcade: unknown ${what} ${ref.id}`);
  return { piece, params: piece.params.parse(ref.params) };
}

export function loadProgram(world: ArcadeWorld, library: ArcadeLibrary): ArcadeProgram {
  return {
    control: bind(library.controls, world.control, 'control'),
    rules: world.rules.map((ref) => bind(library.rules, ref, 'rule')),
  };
}

// ---------------------------------------------------------------------------
// Svět

export interface BuildWorldInput {
  readonly seed: number;
  readonly control: PieceRef;
  readonly rules: readonly PieceRef[];
  readonly bot: PieceRef;
  readonly level: ArcadeLevel;
  /** Počáteční životy (čítač `health`); 0 = hra bez životů. */
  readonly health?: number;
}

export type BuildWorldResult = { readonly ok: true; readonly world: ArcadeWorld } | { readonly ok: false; readonly issues: readonly string[] };

/** Sestaví svět z úrovně a kusů. Meze a neznámé kusy se odmítají tady, ne za běhu. */
export function buildWorld(input: BuildWorldInput, library: ArcadeLibrary): BuildWorldResult {
  const { bodies } = input.level;
  const issues: string[] = [];
  if (bodies.length === 0 || bodies[0]?.role !== 'player') issues.push('level: the first body must be the player');
  if (bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`level: ${bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  if (input.rules.length > ARCADE_LIMITS.maxRules) issues.push(`rules: ${input.rules.length} exceed the ${ARCADE_LIMITS.maxRules} rule limit`);
  const check = (table: Readonly<Record<string, { readonly params: { safeParse(input: unknown): { success: boolean } } }>>, ref: PieceRef, what: string): void => {
    const piece = table[ref.id];
    if (piece === undefined) issues.push(`${what}: unknown piece ${ref.id}`);
    else if (!piece.params.safeParse(ref.params).success) issues.push(`${what}: invalid params for ${ref.id}`);
  };
  check(library.controls, input.control, 'control');
  input.rules.forEach((ref, index) => check(library.rules, ref, `rules/${index}`));
  check(library.bots, input.bot, 'bot');
  if (issues.length > 0) return { ok: false, issues };

  const kinds = [...new Set(bodies.map((body) => body.kind))];
  const state = new Int32Array(stateSize(bodies.length));
  state[HEADER.runState] = RUN_STATE.running;
  state[HEADER.bodyCount] = bodies.length;
  state[HEADER.player] = 0;
  state[HEADER.counters + COUNTER.health] = input.health ?? 0;
  bodies.forEach((body, index) => {
    const base = bodyBase(index);
    state[base + BODY.x] = body.x;
    state[base + BODY.y] = body.y;
    state[base + BODY.z] = body.z;
    state[base + BODY.w] = body.w;
    state[base + BODY.h] = body.h;
    state[base + BODY.d] = body.d;
    state[base + BODY.role] = ROLE[body.role];
    state[base + BODY.kind] = kinds.indexOf(body.kind);
    const player = index === 0 ? FLAG.gravity | FLAG.grounded : 0;
    state[base + BODY.flags] = FLAG.alive | (body.solid ? FLAG.solid : 0) | player;
  });

  return {
    ok: true,
    world: {
      runtimeVersion: ARCADE_RUNTIME_VERSION,
      seed: input.seed,
      control: input.control,
      rules: input.rules,
      bot: input.bot,
      kinds,
      length: input.level.length,
      initial: Array.from(state),
    },
  };
}

export function instantiate(world: ArcadeWorld): ArcadeState {
  const state = Int32Array.from(world.initial);
  const count = state[HEADER.bodyCount] as number;
  if (state.length !== HEADER_SIZE + count * BODY_STRIDE || count > ARCADE_LIMITS.maxBodies) throw new Error('arcade: malformed initial state');
  return state;
}

// ---------------------------------------------------------------------------
// Tik

const alive = (state: ArcadeState, base: number): boolean => ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;

/** Průnik AABB; `x/z` je střed, `y` spodní stěna. Dotyk hranou není průnik. */
function overlaps(state: ArcadeState, a: number, b: number): boolean {
  return (
    Math.abs((state[a + BODY.x] as number) - (state[b + BODY.x] as number)) * 2 < (state[a + BODY.w] as number) + (state[b + BODY.w] as number) &&
    Math.abs((state[a + BODY.z] as number) - (state[b + BODY.z] as number)) * 2 < (state[a + BODY.d] as number) + (state[b + BODY.d] as number) &&
    (state[a + BODY.y] as number) < (state[b + BODY.y] as number) + (state[b + BODY.h] as number) &&
    (state[b + BODY.y] as number) < (state[a + BODY.y] as number) + (state[a + BODY.h] as number)
  );
}

function integrate(state: ArcadeState, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (!alive(state, base)) continue;
    const flags = state[base + BODY.flags] as number;
    if ((flags & FLAG.gravity) !== 0) {
      state[base + BODY.vy] = (state[base + BODY.vy] as number) - GRAVITY;
      state[base + BODY.flags] = flags & ~FLAG.grounded;
    }
    state[base + BODY.x] = (state[base + BODY.x] as number) + (state[base + BODY.vx] as number);
    state[base + BODY.y] = (state[base + BODY.y] as number) + (state[base + BODY.vy] as number);
    state[base + BODY.z] = (state[base + BODY.z] as number) + (state[base + BODY.vz] as number);
    if ((flags & FLAG.gravity) !== 0 && (state[base + BODY.y] as number) <= 0) {
      state[base + BODY.y] = 0;
      state[base + BODY.vy] = 0;
      state[base + BODY.flags] = (state[base + BODY.flags] as number) | FLAG.grounded;
    }
  }
}

/** Kolize hráče: dopad shora na pevné tělo hráče postaví na jeho horní hranu, ostatní průniky jsou kontakty. */
function collide(state: ArcadeState, count: number, player: number, prevY: number): number[] {
  const p = bodyBase(player);
  const contacts: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    if (!alive(state, base) || !overlaps(state, p, base)) continue;
    const top = (state[base + BODY.y] as number) + (state[base + BODY.h] as number);
    const solid = ((state[base + BODY.flags] as number) & FLAG.solid) !== 0;
    if (solid && prevY >= top && (state[p + BODY.vy] as number) <= 0) {
      state[p + BODY.y] = top;
      state[p + BODY.vy] = 0;
      state[p + BODY.flags] = (state[p + BODY.flags] as number) | FLAG.grounded;
      continue;
    }
    contacts.push(i);
  }
  return contacts;
}

function collect(effects: ArcadeEffect[], fired: readonly ArcadeEffect[]): void {
  for (const effect of fired) {
    if (effects.length >= ARCADE_LIMITS.maxEffectsPerTick) return;
    effects.push(effect);
  }
}

function apply(state: ArcadeState, count: number, effects: readonly ArcadeEffect[], from: number): void {
  let won = false;
  let lost = false;
  for (let i = from; i < effects.length; i += 1) {
    const effect = effects[i] as ArcadeEffect;
    if (effect.kind === 'score') state[HEADER.counters + COUNTER.score] = (state[HEADER.counters + COUNTER.score] as number) + effect.amount;
    else if (effect.kind === 'damage') state[HEADER.counters + COUNTER.health] = (state[HEADER.counters + COUNTER.health] as number) - effect.amount;
    else if (effect.kind === 'lose') lost = true;
    else if (effect.kind === 'win') won = true;
    else if (effect.body >= 0 && effect.body < count) {
      const flags = bodyBase(effect.body) + BODY.flags;
      state[flags] = (state[flags] as number) & ~FLAG.alive;
    }
  }
  // Prohra má přednost: náraz a páska v tomtéž tiku není výhra.
  if (lost) state[HEADER.runState] = RUN_STATE.lost;
  else if (won) state[HEADER.runState] = RUN_STATE.won;
}

/** Jeden tik. Po konci běhu (`won`/`lost`) nedělá nic. Vrací efekty, které pravidla v tiku vydala. */
export function step(state: ArcadeState, input: ArcadeInput, program: ArcadeProgram): readonly ArcadeEffect[] {
  if (state[HEADER.runState] !== RUN_STATE.running) return [];
  const count = state[HEADER.bodyCount] as number;
  const player = state[HEADER.player] as number;

  program.control.piece.step(state, player, input, program.control.params);
  const prevY = state[bodyBase(player) + BODY.y] as number;
  integrate(state, count);
  const contacts = collide(state, count, player, prevY);

  const effects: ArcadeEffect[] = [];
  for (const other of contacts) {
    for (const rule of program.rules) {
      if (rule.piece.trigger === 'contact') collect(effects, rule.piece.fire({ state, player, other }, rule.params));
    }
  }
  for (const rule of program.rules) {
    if (rule.piece.trigger === 'tick') collect(effects, rule.piece.fire({ state, player, other: -1 }, rule.params));
  }
  apply(state, count, effects, 0);
  const countersFrom = effects.length;
  for (const rule of program.rules) {
    if (rule.piece.trigger === 'counter') collect(effects, rule.piece.fire({ state, player, other: -1 }, rule.params));
  }
  apply(state, count, effects, countersFrom);

  state[HEADER.tick] = (state[HEADER.tick] as number) + 1;
  return effects;
}

export function hashArcade(state: ArcadeState): string {
  return hashHex(new Uint32Array(state.buffer, state.byteOffset, state.length));
}

export function outcomeOf(state: ArcadeState): ArcadeOutcome {
  const code = state[HEADER.runState];
  return code === RUN_STATE.won ? 'won' : code === RUN_STATE.lost ? 'lost' : 'running';
}

export interface ReplayResult {
  readonly hash: string;
  readonly outcome: ArcadeOutcome;
  readonly tick: number;
}

/**
 * Přehraje záznam od tiku 0 do konce běhu nebo horizontu. Záznam je řídký
 * (jen tiky se vstupem) a musí být seřazený podle tiku.
 */
export function replay(world: ArcadeWorld, inputs: readonly InputEvent[], library: ArcadeLibrary, horizon: number = ARCADE_LIMITS.maxTicks): ReplayResult {
  const program = loadProgram(world, library);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < horizon && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return { hash: hashArcade(state), outcome: outcomeOf(state), tick: state[HEADER.tick] as number };
}
