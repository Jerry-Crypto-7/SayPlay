/**
 * Arkádové jádro (P25A, T2; v2 P25C): `step()`, hash a přehrání.
 *
 * Tik: vstup → ovládání → vezení na kinematickém tělese → integrace
 * (rychlost, gravitace) → stohování padajících těl → kolize AABB hráče s ostatními (pevné tělo zastaví
 * shora, zdola i z boku; přistání shora není náraz) → projektily (život,
 * zásah, odraz; P25G) → pravidla → úklid. Všechno jsou celá čísla v `Int32Array`; jádro nemá hodiny ani
 * náhodu, takže stav v tiku *t* je funkce počátečního stavu a vstupů 0..*t*.
 * Každá smyčka jde přes těla nebo pravidla světa, a těch je nejvýš
 * `ARCADE_LIMITS` (ohlídá `buildWorld`).
 */

import { hashHex } from '@/sim/hash';

import {
  ARCADE_LIMITS,
  ARCADE_RUNTIME_VERSION,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeLevel,
  type ArcadeState,
  type ArcadeWorld,
  BODY,
  BODY_STRIDE,
  BOUNCE_MAX,
  type BotPiece,
  COUNTER,
  type ControlPiece,
  FLAG,
  type GeneratorPiece,
  HEADER,
  HEADER_SIZE,
  type InputEvent,
  NO_INPUT,
  PROJECTILE_LIFETIME,
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
  const capacity = bodies.length + (input.level.spawnSlots ?? 0);
  const issues: string[] = [];
  if (bodies.length === 0 || bodies[0]?.role !== 'player') issues.push('level: the first body must be the player');
  if (capacity > ARCADE_LIMITS.maxBodies) issues.push(`level: ${capacity} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  if (input.rules.length > ARCADE_LIMITS.maxRules) issues.push(`rules: ${input.rules.length} exceed the ${ARCADE_LIMITS.maxRules} rule limit`);
  const check = (table: Readonly<Record<string, { readonly params: { safeParse(input: unknown): { success: boolean } } }>>, ref: PieceRef, what: string): void => {
    const piece = table[ref.id];
    if (piece === undefined) issues.push(`${what}: unknown piece ${ref.id}`);
    else if (!piece.params.safeParse(ref.params).success) issues.push(`${what}: invalid params for ${ref.id}`);
  };
  check(library.controls, input.control, 'control');
  input.rules.forEach((ref, index) => check(library.rules, ref, `rules/${index}`));
  check(library.bots, input.bot, 'bot');
  // Projektil musí zaniknout: konečná životnost je jediná mez jeho letu.
  bodies.forEach((body, index) => {
    if (body.role !== 'projectile') {
      if (body.lifetime !== undefined || body.bounce !== undefined) issues.push(`bodies/${index}: lifetime and bounce belong to projectiles`);
      return;
    }
    const lifetime = body.lifetime ?? PROJECTILE_LIFETIME;
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > ARCADE_LIMITS.maxTicks) issues.push(`bodies/${index}: projectile lifetime ${lifetime} outside 1..${ARCADE_LIMITS.maxTicks}`);
    const bounce = body.bounce ?? 0;
    if (!Number.isInteger(bounce) || bounce < 0 || bounce > BOUNCE_MAX) issues.push(`bodies/${index}: projectile bounce ${bounce} outside 0..${BOUNCE_MAX}`);
    if (body.kinematic === true) issues.push(`bodies/${index}: a projectile cannot be kinematic`);
  });
  if (issues.length > 0) return { ok: false, issues };

  const kinds = [...new Set(bodies.map((body) => body.kind))];
  const state = new Int32Array(stateSize(capacity));
  state[HEADER.runState] = RUN_STATE.running;
  state[HEADER.bodyCount] = bodies.length;
  state[HEADER.player] = 0;
  state[HEADER.spawnBase] = bodies.length;
  state[HEADER.respawnX] = bodies[0]?.x ?? 0;
  state[HEADER.respawnY] = bodies[0]?.y ?? 0;
  state[HEADER.respawnZ] = bodies[0]?.z ?? 0;
  state[HEADER.counters + COUNTER.health] = input.health ?? 0;
  for (const [name, value] of Object.entries(input.level.counters ?? {})) state[HEADER.counters + COUNTER[name as ArcadeCounter]] = value;
  bodies.forEach((body, index) => {
    const base = bodyBase(index);
    state[base + BODY.x] = body.x;
    state[base + BODY.y] = body.y;
    state[base + BODY.z] = body.z;
    state[base + BODY.vx] = body.vx ?? 0;
    state[base + BODY.vy] = body.vy ?? 0;
    state[base + BODY.vz] = body.vz ?? 0;
    state[base + BODY.w] = body.w;
    state[base + BODY.h] = body.h;
    state[base + BODY.d] = body.d;
    state[base + BODY.role] = ROLE[body.role];
    state[base + BODY.kind] = kinds.indexOf(body.kind);
    if (body.kinematic === true) state[base + BODY.aux1] = body.period ?? 0;
    if (body.role === 'projectile') {
      state[base + BODY.aux0] = body.bounce ?? 0;
      state[base + BODY.aux1] = body.lifetime ?? PROJECTILE_LIFETIME;
    }
    const player = index === 0 ? FLAG.gravity | FLAG.grounded : 0;
    state[base + BODY.flags] =
      (body.template === true ? 0 : FLAG.alive) |
      (body.solid ? FLAG.solid : 0) |
      (body.gravity === true ? FLAG.gravity : 0) |
      (body.kinematic === true ? FLAG.kinematic : 0) |
      player;
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

/** Hlavička `arcade-v1`: tick, runState, bodyCount, player, 8 čítačů – těla od slotu 12. */
const V1_HEADER_SIZE = 12;

/**
 * Počáteční stav hry uložené pod `arcade-v1` (P25A) v rozložení v2: vloží
 * `spawnBase` a místo návratu (start hráče), čítače a těla posune. Bez toho
 * by v2 četla těla o čtyři sloty vedle.
 */
function upgradeV1(initial: readonly number[]): Int32Array {
  const count = initial[HEADER.bodyCount] as number;
  // Počet těl se čte z uloženého stavu, takže se ověřuje dřív, než podle něj
  // něco alokujeme – jinak by vadný záznam žádal o pole libovolné velikosti.
  if (!Number.isInteger(count) || count < 0 || count > ARCADE_LIMITS.maxBodies || V1_HEADER_SIZE + count * BODY_STRIDE > initial.length) {
    throw new Error('arcade: malformed initial state');
  }
  const state = new Int32Array(stateSize(count));
  for (let i = 0; i < 4; i += 1) state[i] = initial[i] as number;
  for (let i = 0; i < ARCADE_LIMITS.maxCounters; i += 1) state[HEADER.counters + i] = initial[4 + i] as number;
  for (let i = 0; i < count * BODY_STRIDE; i += 1) state[HEADER_SIZE + i] = initial[V1_HEADER_SIZE + i] as number;
  const player = bodyBase(state[HEADER.player] as number);
  state[HEADER.spawnBase] = count;
  state[HEADER.respawnX] = state[player + BODY.x] as number;
  state[HEADER.respawnY] = state[player + BODY.y] as number;
  state[HEADER.respawnZ] = state[player + BODY.z] as number;
  return state;
}

export function instantiate(world: ArcadeWorld): ArcadeState {
  const state = (world.runtimeVersion as string) === 'arcade-v1' ? upgradeV1(world.initial) : Int32Array.from(world.initial);
  const count = state[HEADER.bodyCount] as number;
  const capacity = (state.length - HEADER_SIZE) / BODY_STRIDE;
  if (!Number.isInteger(capacity) || count > capacity || capacity > ARCADE_LIMITS.maxBodies) throw new Error('arcade: malformed initial state');
  return state;
}

// ---------------------------------------------------------------------------
// Tik

// Místní kopie importů pro horkou smyčku: pod vitestem je každý importovaný
// název getter modulu a tik s nimi stál 15× víc než v prohlížeči (50 µs × 3 µs).
const S = BODY;
const F = FLAG;
const HD = HEADER;
const CT = COUNTER;
const R = ROLE;
const baseOf = bodyBase;

const alive = (state: ArcadeState, base: number): boolean => ((state[base + S.flags] as number) & F.alive) !== 0;

/** Průnik AABB; `x/z` je střed, `y` spodní stěna. Dotyk hranou není průnik. */
function overlaps(state: ArcadeState, a: number, b: number): boolean {
  return (
    Math.abs((state[a + S.x] as number) - (state[b + S.x] as number)) * 2 < (state[a + S.w] as number) + (state[b + S.w] as number) &&
    Math.abs((state[a + S.z] as number) - (state[b + S.z] as number)) * 2 < (state[a + S.d] as number) + (state[b + S.d] as number) &&
    (state[a + S.y] as number) < (state[b + S.y] as number) + (state[b + S.h] as number) &&
    (state[b + S.y] as number) < (state[a + S.y] as number) + (state[a + S.h] as number)
  );
}

function integrate(state: ArcadeState, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const base = baseOf(i);
    if (!alive(state, base)) continue;
    const flags = state[base + S.flags] as number;
    // Kinematické tělo jede jen svou rychlostí: gravitace ani země na něj nepůsobí.
    const falls = (flags & (F.gravity | F.kinematic)) === F.gravity;
    if (falls) {
      state[base + S.vy] = (state[base + S.vy] as number) - GRAVITY;
      state[base + S.flags] = flags & ~F.grounded;
    }
    state[base + S.x] = (state[base + S.x] as number) + (state[base + S.vx] as number);
    state[base + S.y] = (state[base + S.y] as number) + (state[base + S.vy] as number);
    state[base + S.z] = (state[base + S.z] as number) + (state[base + S.vz] as number);
    // Dopad projektilu (odraz, nebo zánik) řeší `projectiles()`, tady by jen ztratil rychlost.
    if (falls && (state[base + S.y] as number) <= 0 && state[base + S.role] !== R.projectile) {
      state[base + S.y] = 0;
      state[base + S.vy] = 0;
      state[base + S.flags] = (state[base + S.flags] as number) | F.grounded;
    }
    // Kyvadlo: kinematické tělo s periodou po `aux1` ticích obrátí směr.
    if ((flags & F.kinematic) !== 0 && (state[base + S.aux1] as number) > 0) {
      const leg = (state[base + S.aux0] as number) + 1;
      if (leg >= (state[base + S.aux1] as number)) {
        state[base + S.aux0] = 0;
        state[base + S.vx] = -(state[base + S.vx] as number);
        state[base + S.vy] = -(state[base + S.vy] as number);
        state[base + S.vz] = -(state[base + S.vz] as number);
      } else state[base + S.aux0] = leg;
    }
  }
}

/**
 * Stohování (P25G): padající tělo (gravitace, ne hráč, ne projektil, ne
 * kinematické), které za tik propadlo horní hranou pevného těla pod sebou,
 * na ní přistane. Pořadí podle indexu – generátor staví věž odspodu, takže
 * spodní blok je usazený dřív, než na něj dosedne horní. Když podpora zmizí
 * (despawn), tělo příští tik padá dál na další podporu nebo zem.
 */
function settle(state: ArcadeState, count: number, player: number): void {
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = baseOf(i);
    const flags = state[base + S.flags] as number;
    if ((flags & (F.alive | F.gravity | F.kinematic)) !== (F.alive | F.gravity) || state[base + S.role] === R.projectile) continue;
    const y = state[base + S.y] as number;
    if (y <= 0) continue;
    const prevY = y - (state[base + S.vy] as number);
    let support = -1;
    for (let j = 0; j < count; j += 1) {
      if (j === i) continue;
      const other = baseOf(j);
      if (((state[other + S.flags] as number) & (F.alive | F.solid)) !== (F.alive | F.solid)) continue;
      const top = (state[other + S.y] as number) + (state[other + S.h] as number);
      if (top > prevY || top <= y || top <= support) continue;
      if (Math.abs((state[base + S.x] as number) - (state[other + S.x] as number)) * 2 >= (state[base + S.w] as number) + (state[other + S.w] as number)) continue;
      if (Math.abs((state[base + S.z] as number) - (state[other + S.z] as number)) * 2 >= (state[base + S.d] as number) + (state[other + S.d] as number)) continue;
      support = top;
    }
    if (support < 0) continue;
    state[base + S.y] = support;
    state[base + S.vy] = 0;
    state[base + S.flags] = (state[base + S.flags] as number) | F.grounded;
  }
}

/** Hráč stojící na kinematickém tělese se s ním veze: přičte jeho rychlost ještě před integrací. */
function carry(state: ArcadeState, count: number, player: number): void {
  const p = baseOf(player);
  if (((state[p + S.flags] as number) & F.grounded) === 0) return;
  const py = state[p + S.y] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = baseOf(i);
    const flags = state[base + S.flags] as number;
    if ((flags & (F.alive | F.solid | F.kinematic)) !== (F.alive | F.solid | F.kinematic)) continue;
    if ((state[base + S.y] as number) + (state[base + S.h] as number) !== py) continue;
    if (Math.abs((state[p + S.x] as number) - (state[base + S.x] as number)) * 2 >= (state[p + S.w] as number) + (state[base + S.w] as number)) continue;
    if (Math.abs((state[p + S.z] as number) - (state[base + S.z] as number)) * 2 >= (state[p + S.d] as number) + (state[base + S.d] as number)) continue;
    state[p + S.x] = (state[p + S.x] as number) + (state[base + S.vx] as number);
    state[p + S.y] = py + (state[base + S.vy] as number);
    state[p + S.z] = (state[p + S.z] as number) + (state[base + S.vz] as number);
    return;
  }
}

/**
 * Kolize hráče s pevnými tělesy podle toho, odkud přišel (poloha před
 * integrací, u těla jeho poloha minus rychlost): shora = stojí na horní hraně
 * (není kontakt), zdola = strop, z boku = zastaví se na hraně a `vx`/`vz` = 0.
 * Strop i bok hlásí kontakt dál, nepevná tělesa jsou jen kontakt.
 */
function collide(state: ArcadeState, count: number, player: number, prevX: number, prevY: number, prevZ: number): number[] {
  const p = baseOf(player);
  const contacts: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = baseOf(i);
    // Projektil hráče nezastaví ani se ho nedotkne: vylétá z něj.
    if (!alive(state, base) || state[base + S.role] === R.projectile || !overlaps(state, p, base)) continue;
    if (((state[base + S.flags] as number) & F.solid) === 0) {
      contacts.push(i);
      continue;
    }
    const bx = state[base + S.x] as number;
    const by = state[base + S.y] as number;
    const bz = state[base + S.z] as number;
    const bvy = state[base + S.vy] as number;
    const top = by + (state[base + S.h] as number);
    if (prevY >= top - bvy && (state[p + S.vy] as number) <= bvy) {
      state[p + S.y] = top;
      state[p + S.vy] = 0;
      state[p + S.flags] = (state[p + S.flags] as number) | F.grounded;
      continue;
    }
    const ph = state[p + S.h] as number;
    if (prevY + ph <= by - bvy) {
      state[p + S.y] = by - ph;
      state[p + S.vy] = 0;
    } else {
      const halfW = Math.ceil(((state[p + S.w] as number) + (state[base + S.w] as number)) / 2);
      const halfD = Math.ceil(((state[p + S.d] as number) + (state[base + S.d] as number)) / 2);
      const dx = prevX - (bx - (state[base + S.vx] as number));
      const dz = prevZ - (bz - (state[base + S.vz] as number));
      const fromX = Math.abs(dx) >= halfW;
      const fromZ = Math.abs(dz) >= halfD;
      // Přišel šikmo přes roh: rozhodne menší průnik.
      const penX = halfW - Math.abs((state[p + S.x] as number) - bx);
      const penZ = halfD - Math.abs((state[p + S.z] as number) - bz);
      if (fromX && (!fromZ || penX <= penZ)) {
        state[p + S.x] = bx + (dx < 0 ? -halfW : halfW);
        state[p + S.vx] = 0;
      } else if (fromZ) {
        state[p + S.z] = bz + (dz < 0 ? -halfD : halfD);
        state[p + S.vz] = 0;
      }
    }
    contacts.push(i);
  }
  return contacts;
}

/**
 * Průnik těla `b` s dráhou projektilu `a` za poslední tik (obal staré a nové
 * polohy), aby rychlá střela nepropadla tenkým terčem. Souřadnice x/z zdvojené.
 */
function sweptHits(state: ArcadeState, a: number, b: number): boolean {
  const vx = state[a + S.vx] as number;
  const vy = state[a + S.vy] as number;
  const vz = state[a + S.vz] as number;
  const ay = state[a + S.y] as number;
  const bottom = Math.min(ay, ay - vy);
  const top = Math.max(ay, ay - vy) + (state[a + S.h] as number);
  return (
    Math.abs(2 * (state[a + S.x] as number) - vx - 2 * (state[b + S.x] as number)) < (state[a + S.w] as number) + Math.abs(vx) + (state[b + S.w] as number) &&
    Math.abs(2 * (state[a + S.z] as number) - vz - 2 * (state[b + S.z] as number)) < (state[a + S.d] as number) + Math.abs(vz) + (state[b + S.d] as number) &&
    bottom < (state[b + S.y] as number) + (state[b + S.h] as number) &&
    (state[b + S.y] as number) < top
  );
}

/**
 * Projektily po integraci: ubere tik života, hledá zásah (terč, nepřítel,
 * pevné tělo; první podle indexu), na zemi odrazí nebo ukončí. Skončený
 * projektil jádro despawnuje a vrátí dvojice [projektil, zasažené tělo nebo −1]
 * pro pravidla `hit`. Život je konečný (`buildWorld`), takže každý jednou skončí.
 */
function projectiles(state: ArcadeState, count: number, player: number): number[] {
  const ended: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = baseOf(i);
    if (state[base + S.role] !== R.projectile || !alive(state, base)) continue;
    let struck = -2;
    const life = (state[base + S.aux1] as number) - 1;
    state[base + S.aux1] = life;
    for (let j = 0; j < count && struck === -2; j += 1) {
      if (j === i || j === player) continue;
      const other = baseOf(j);
      const role = state[other + S.role] as number;
      if (!alive(state, other) || role === R.projectile) continue;
      if ((role === R.target || role === R.enemy || ((state[other + S.flags] as number) & F.solid) !== 0) && sweptHits(state, base, other)) struck = j;
    }
    if (struck === -2 && ((state[base + S.flags] as number) & F.gravity) !== 0 && (state[base + S.y] as number) <= 0) {
      const bounce = state[base + S.aux0] as number;
      const vy = Math.trunc((-(state[base + S.vy] as number) * bounce) / BOUNCE_MAX);
      // Odraz slabší než dva tiky gravitace = míček se dokutálel.
      if (vy <= 2 * GRAVITY) struck = -1;
      else {
        state[base + S.y] = 0;
        state[base + S.vy] = vy;
        state[base + S.vx] = Math.trunc(((state[base + S.vx] as number) * bounce) / BOUNCE_MAX);
        state[base + S.vz] = Math.trunc(((state[base + S.vz] as number) * bounce) / BOUNCE_MAX);
      }
    }
    if (struck === -2 && life <= 0) struck = -1;
    if (struck === -2) continue;
    state[base + S.flags] = (state[base + S.flags] as number) & ~F.alive;
    ended.push(i, struck);
  }
  return ended;
}

function collect(effects: ArcadeEffect[], fired: readonly ArcadeEffect[]): void {
  for (const effect of fired) {
    if (effects.length >= ARCADE_LIMITS.maxEffectsPerTick) return;
    effects.push(effect);
  }
}

/**
 * Efekt `spawn`: slot = první mrtvý od `spawnBase` (těla úrovně se nikdy
 * nepřepíšou), jinak další volný v rezervě; plno → zahodit.
 */
function spawn(state: ArcadeState, effect: Extract<ArcadeEffect, { kind: 'spawn' }>): void {
  const count = state[HD.bodyCount] as number;
  if (effect.template < 0 || effect.template >= count) return;
  let slot = -1;
  for (let i = state[HD.spawnBase] as number; i < count && slot < 0; i += 1) if (!alive(state, baseOf(i))) slot = i;
  if (slot < 0 && baseOf(count + 1) <= state.length) {
    slot = count;
    state[HD.bodyCount] = count + 1;
  }
  if (slot < 0) return;
  const from = baseOf(effect.template);
  const to = baseOf(slot);
  state.copyWithin(to, from, from + BODY_STRIDE);
  state[to + S.x] = effect.x;
  state[to + S.y] = effect.y;
  state[to + S.z] = effect.z;
  state[to + S.vx] = effect.vx;
  state[to + S.vy] = effect.vy;
  state[to + S.vz] = effect.vz;
  // Projektil si z předlohy nese odraz a plný život; ostatním se pracovní sloty nulují.
  if (state[to + S.role] !== R.projectile) {
    state[to + S.aux0] = 0;
    state[to + S.aux1] = 0;
  }
  state[to + S.flags] = ((state[to + S.flags] as number) | F.alive) & ~(F.grounded | F.sliding);
}

function apply(state: ArcadeState, effects: readonly ArcadeEffect[], from: number): void {
  let won = false;
  let lost = false;
  for (let i = from; i < effects.length; i += 1) {
    const effect = effects[i] as ArcadeEffect;
    if (effect.kind === 'score') state[HD.counters + CT.score] = (state[HD.counters + CT.score] as number) + effect.amount;
    else if (effect.kind === 'damage') state[HD.counters + CT.health] = (state[HD.counters + CT.health] as number) - effect.amount;
    else if (effect.kind === 'count') state[HD.counters + CT[effect.counter]] = (state[HD.counters + CT[effect.counter]] as number) + effect.amount;
    else if (effect.kind === 'lose') lost = true;
    else if (effect.kind === 'win') won = true;
    else if (effect.kind === 'spawn') spawn(state, effect);
    else if (effect.kind === 'respawn') {
      const p = baseOf(state[HD.player] as number);
      state[p + S.x] = state[HD.respawnX] as number;
      state[p + S.y] = state[HD.respawnY] as number;
      state[p + S.z] = state[HD.respawnZ] as number;
      state[p + S.vx] = 0;
      state[p + S.vy] = 0;
      state[p + S.vz] = 0;
      state[p + S.flags] = (state[p + S.flags] as number) | F.grounded;
    } else if (effect.body >= 0 && effect.body < (state[HD.bodyCount] as number)) {
      const base = baseOf(effect.body);
      if (effect.kind === 'despawn') state[base + S.flags] = (state[base + S.flags] as number) & ~F.alive;
      else {
        state[HD.respawnX] = state[base + S.x] as number;
        state[HD.respawnY] = (state[base + S.y] as number) + (state[base + S.h] as number);
        state[HD.respawnZ] = state[base + S.z] as number;
      }
    }
  }
  // Prohra má přednost: náraz a páska v tomtéž tiku není výhra.
  if (lost) state[HD.runState] = RUN_STATE.lost;
  else if (won) state[HD.runState] = RUN_STATE.won;
}

/** Jeden tik. Po konci běhu (`won`/`lost`) nedělá nic. Vrací efekty, které pravidla v tiku vydala. */
export function step(state: ArcadeState, input: ArcadeInput, program: ArcadeProgram): readonly ArcadeEffect[] {
  if (state[HD.runState] !== RUN_STATE.running) return [];
  const count = state[HD.bodyCount] as number;
  const player = state[HD.player] as number;

  program.control.piece.step(state, player, input, program.control.params);
  carry(state, count, player);
  const p = baseOf(player);
  const prevX = state[p + S.x] as number;
  const prevY = state[p + S.y] as number;
  const prevZ = state[p + S.z] as number;
  integrate(state, count);
  settle(state, count, player);
  const contacts = collide(state, count, player, prevX, prevY, prevZ);
  const ended = projectiles(state, count, player);

  const effects: ArcadeEffect[] = [];
  for (const other of contacts) {
    for (const rule of program.rules) {
      if (rule.piece.trigger === 'contact') collect(effects, rule.piece.fire({ state, player, other, source: -1 }, rule.params));
    }
  }
  for (let k = 0; k < ended.length; k += 2) {
    for (const rule of program.rules) {
      if (rule.piece.trigger === 'hit') collect(effects, rule.piece.fire({ state, player, other: ended[k + 1] as number, source: ended[k] as number }, rule.params));
    }
  }
  for (const rule of program.rules) {
    if (rule.piece.trigger === 'tick') collect(effects, rule.piece.fire({ state, player, other: -1, source: -1 }, rule.params));
  }
  apply(state, effects, 0);
  const countersFrom = effects.length;
  for (const rule of program.rules) {
    if (rule.piece.trigger === 'counter') collect(effects, rule.piece.fire({ state, player, other: -1, source: -1 }, rule.params));
  }
  apply(state, effects, countersFrom);

  state[HD.tick] = (state[HD.tick] as number) + 1;
  return effects;
}

export function hashArcade(state: ArcadeState): string {
  return hashHex(new Uint32Array(state.buffer, state.byteOffset, state.length));
}

export function outcomeOf(state: ArcadeState): ArcadeOutcome {
  const code = state[HD.runState];
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
  for (let tick = 0; tick < horizon && state[HD.runState] === RUN_STATE.running; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return { hash: hashArcade(state), outcome: outcomeOf(state), tick: state[HD.tick] as number };
}
