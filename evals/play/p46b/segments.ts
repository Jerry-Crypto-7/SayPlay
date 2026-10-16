/**
 * Měřidlo úseků (P46B T1): mění každý úsek hry něco, co hráč pocítí? Přehraje
 * záznam robota a stav jen čte (vzor `telemetry.ts`), takže hash běhu je
 * s měřidlem i bez něj stejný.
 *
 * Úseky jsou `PACING.segments` nad **postupem hráče po trati** (`z / length`
 * v promile, nejvyšší dosažený – pád zpátky na checkpoint úsek nevrátí):
 * rozjezd 0–200, úsek 2 200–650, úsek 3 650–850, finále 850–1000. Běžec,
 * řízení i skákačka jsou trati v ose `z`, jinou hru měřidlo neměří.
 *
 * **Rovina** (P47A T8: aréna, quest v prostoru – hra s průběhem, jehož cíl není
 * ujetá trať): postup je `progressOf` cíle `pacing_control` (věci, skóre, kola,
 * čas), ne `z`; zorné pole je celá aréna. Rychlost vpřed, šířka trati ani
 * hustota na 100 m tam smysl nemají – změnu úseku dává jen nový nepřítel
 * a nový druh prostředí.
 *
 * `segmentChanges` = kolik z úseků 2 a 3 přineslo proti předchozímu aspoň
 * jednu hratelnou změnu (0–2). Finále měří `finale` telemetrie P45A, ne tohle.
 * Hratelná změna je jen jedna z těchto:
 * - **nový nepřítel** – podpis hrozby `<role>:<pohyb>` (`static`, `chase`,
 *   `roam` jako `telemetry.ts`), který žádný dřívější úsek neměl. Model ani
 *   barva v podpisu nejsou: nový vzhled téhož chování není změna;
 * - **rychlost** – rychlost hráče vpřed (medián tiků úseku: krátké turbo ani
 *   chvíle čekání úsek nezmění) je proti předchozímu aspoň o `SPEED_STEP` vyšší.
 *   Jen růst: pomalejší robot skákačky je následek těžší trati, ne nové tempo;
 * - **prostředí** – nový podpis těla trati `<role>:<static|moving>` (pohyblivá
 *   plošina, nová past), nebo šířka trati mezi dlouhými stěnami (medián úseku)
 *   jiná aspoň o `WIDTH_STEP`;
 * - **hustota** – překážek a hrozeb na 100 m aspoň `DENSITY_STEP`× víc a aspoň
 *   o `DENSITY_MIN` víc. Jen růst: řidší úsek nic nového nepřináší a pár těl na
 *   začátku (soupeři na startu řízení) je náhoda rozestavění, ne stupňování.
 */

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld, BODY, FLAG, HEADER, type InputEvent, NO_INPUT, type PieceRef, ROLE, RUN_STATE, UNIT, bodyBase } from '@/play/arcade/contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { PACING, type PacingGoal, progressOf } from '@/play/arcade/pieces/pacing';
import { releasePhysics } from '@/play/arcade/physics/step';
import { CHASE_COSINE, SAMPLE_TICKS, STATIC_PATH } from '@/play/arcade/telemetry';

/** Hranice úseků v promile postupu: rozjezd | úsek 2 | úsek 3 | finále. */
export const SEGMENT_EDGES = [PACING.segments.intro, PACING.segments.buildUp, PACING.segments.peak] as const;
export const SEGMENT_NAMES = ['intro', 'segment2', 'segment3', 'finale'] as const;
/** Rychlost se změnila, když se liší aspoň o 10 % (jeden krok rampy `RAMP_STEP_PCT`). */
export const SPEED_STEP = 0.1;
export const WIDTH_STEP = 0.1;
export const DENSITY_STEP = 1.5;
/** Na 100 m. */
export const DENSITY_MIN = 2;
/** Tělo je v zorném poli úseku, když leží do 40 m před hráčem a 5 m za ním. */
export const VIEW_AHEAD = 40 * UNIT;
export const VIEW_BEHIND = 5 * UNIT;
/** Stěna trati je pevná překážka aspoň 10 m dlouhá (mantinel řízení), řada běžce ne. */
export const LONG_WALL = 10 * UNIT;

const THREATS: ReadonlySet<number> = new Set([ROLE.chaser, ROLE.enemy, ROLE.hazard]);
const TERRAIN: ReadonlySet<number> = new Set([ROLE.obstacle, ROLE.platform]);
const ROLE_NAME = new Map<number, string>(Object.entries(ROLE).map(([name, code]) => [code, name]));

export interface SegmentFacts {
  /** Tiků, které hráč v úseku strávil; 0 = do úseku nedošel. */
  readonly ticks: number;
  /** Metrů postupu v úseku. */
  readonly metres: number;
  readonly foes: readonly string[];
  readonly terrain: readonly string[];
  /** Rychlost vpřed v m/s (medián tiků úseku). */
  readonly speed: number;
  /** Překážek a hrozeb poprvé viděných v úseku na 100 m postupu. */
  readonly density: number;
  /** Medián volné šířky mezi dlouhými stěnami v m; `null` = trať bez stěn. */
  readonly width: number | null;
}

export interface SegmentRun {
  readonly segments: readonly SegmentFacts[];
  /** Co se změnilo v úseku 2 a v úseku 3 (prázdné = nic). */
  readonly changes: readonly (readonly string[])[];
  readonly segmentChanges: number;
  readonly outcome: ArcadeOutcome;
  readonly hash: string;
}

/** Tělo (slot, tik vzniku) v jednom úseku: pozorování pro pohyb a rozsah. */
interface Seen {
  readonly role: number;
  /** Plošina nebo dlouhá stěna: tvar trati, ne překážka, kterou hráč míjí – do hustoty nejde. */
  readonly ground: boolean;
  path: number;
  cosines: number;
  moves: number;
  last: { x: number; y: number; z: number };
  min: [number, number, number];
  max: [number, number, number];
}

interface Bucket {
  ticks: number;
  from: number;
  to: number;
  speeds: number[];
  widths: number[];
  seen: Map<string, Seen>;
}

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const at = (state: Int32Array, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
const round = (value: number): number => Math.round(value * 100) / 100;

function quantile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] as number;
}

/** Úsek podle postupu v promile. */
export const segmentOf = (permille: number): number => SEGMENT_EDGES.filter((edge) => permille >= edge).length;

/** Volná šířka mezi nejbližší dlouhou stěnou vlevo a vpravo v `z` hráče; `null` = stěna chybí. */
function widthAt(state: Int32Array, player: number): number | null {
  const px = at(state, player, 'x');
  const pz = at(state, player, 'z');
  let left = -Infinity;
  let right = Infinity;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (body === player || !alive(state, body) || at(state, body, 'role') !== ROLE.obstacle) continue;
    const d = at(state, body, 'd');
    const z = at(state, body, 'z');
    if (d < LONG_WALL || Math.abs(pz - z) > d / 2) continue;
    const x = at(state, body, 'x');
    const half = at(state, body, 'w') / 2;
    if (x < px) left = Math.max(left, x + half);
    else right = Math.min(right, x - half);
  }
  return Number.isFinite(left) && Number.isFinite(right) ? right - left : null;
}

/** Cíl postupu průběhu (`pacing_control` pod obaly doplňků), nebo `undefined` = hra bez průběhu. */
function goalOf(control: PieceRef): PacingGoal | undefined {
  if (control.id === 'pacing_control') return control.params.goal as PacingGoal;
  const base = control.params.base as PieceRef | undefined;
  return typeof base === 'object' && base !== null && typeof base.id === 'string' ? goalOf(base) : undefined;
}

/** Zapíše těla v zorném poli hráče do úseku (role hrozeb a trati, ne předlohy); v rovině vidí hráč celou arénu. */
function observe(state: Int32Array, player: number, born: readonly number[], bucket: Bucket, plane: boolean): void {
  const px = at(state, player, 'x');
  const pz = at(state, player, 'z');
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (body === player || !alive(state, body)) continue;
    const role = at(state, body, 'role');
    if (!THREATS.has(role) && !TERRAIN.has(role)) continue;
    const x = at(state, body, 'x');
    const y = at(state, body, 'y');
    const z = at(state, body, 'z');
    // Stěna řízení je delší než zorné pole: viditelná je, když se ho dotkne kterákoli její část.
    const reach = at(state, body, 'd') / 2;
    if (!plane && (z + reach < pz - VIEW_BEHIND || z - reach > pz + VIEW_AHEAD)) continue;
    const key = `${String(body)}@${String(born[body])}`;
    const seen = bucket.seen.get(key);
    if (seen === undefined) {
      bucket.seen.set(key, { role, ground: role === ROLE.platform || 2 * reach >= LONG_WALL, path: 0, cosines: 0, moves: 0, last: { x, y, z }, min: [x, y, z], max: [x, y, z] });
      continue;
    }
    const dx = x - seen.last.x;
    const dz = z - seen.last.z;
    seen.path += Math.hypot(dx, y - seen.last.y, dz);
    const stepLength = Math.hypot(dx, dz);
    const towards = Math.hypot(px - seen.last.x, pz - seen.last.z);
    if (stepLength > 0 && towards > 0) {
      seen.cosines += (dx * (px - seen.last.x) + dz * (pz - seen.last.z)) / (stepLength * towards);
      seen.moves += 1;
    }
    seen.last = { x, y, z };
    seen.min = [Math.min(seen.min[0], x), Math.min(seen.min[1], y), Math.min(seen.min[2], z)];
    seen.max = [Math.max(seen.max[0], x), Math.max(seen.max[1], y), Math.max(seen.max[2], z)];
  }
}

const motionOf = (seen: Seen): string => (seen.path < STATIC_PATH ? 'static' : seen.moves > 0 && seen.cosines / seen.moves > CHASE_COSINE ? 'chase' : 'roam');

function factsOf(bucket: Bucket, firstSeen: ReadonlySet<string>): SegmentFacts {
  const metres = Math.max(0, bucket.to - bucket.from) / UNIT;
  const foes = new Set<string>();
  const terrain = new Set<string>();
  for (const seen of bucket.seen.values()) {
    const name = ROLE_NAME.get(seen.role) ?? String(seen.role);
    if (THREATS.has(seen.role)) foes.add(`${name}:${motionOf(seen)}`);
    else terrain.add(`${name}:${seen.max.some((value, axis) => value - (seen.min[axis] as number) >= STATIC_PATH) ? 'moving' : 'static'}`);
  }
  const widths = bucket.widths;
  return {
    ticks: bucket.ticks,
    metres: round(metres),
    foes: [...foes].sort(),
    terrain: [...terrain].sort(),
    speed: round((quantile(bucket.speeds, 0.5) * ARCADE_HZ) / UNIT),
    density: metres <= 0 ? 0 : round((firstSeen.size * 100) / metres),
    width: widths.length === 0 ? null : round(quantile(widths, 0.5) / UNIT),
  };
}

const differs = (a: number, b: number, step: number): boolean => (a === 0 || b === 0 ? a !== b : Math.abs(a - b) >= step * Math.min(a, b));

/** Co úsek `next` změnil proti `prev` a všem dřívějším (`earlier`); prázdné = nic hratelného. */
export function changesOf(prev: SegmentFacts, next: SegmentFacts, earlier: readonly SegmentFacts[]): string[] {
  if (prev.ticks === 0 || next.ticks === 0) return [];
  const known = (pick: (facts: SegmentFacts) => readonly string[]): Set<string> => new Set(earlier.flatMap(pick));
  const foes = known((facts) => facts.foes);
  const terrain = known((facts) => facts.terrain);
  const changes = [
    ...next.foes.filter((foe) => !foes.has(foe)).map((foe) => `foe:${foe}`),
    ...next.terrain.filter((kind) => !terrain.has(kind)).map((kind) => `terrain:${kind}`),
  ];
  if (next.speed > 0 && next.speed >= prev.speed * (1 + SPEED_STEP)) changes.push(`speed:${String(prev.speed)}->${String(next.speed)}`);
  if (prev.width !== null && next.width !== null && differs(prev.width, next.width, WIDTH_STEP)) changes.push(`width:${String(prev.width)}->${String(next.width)}`);
  if (next.density >= DENSITY_STEP * prev.density && next.density - prev.density >= DENSITY_MIN) changes.push(`density:${String(prev.density)}->${String(next.density)}`);
  return changes;
}

/**
 * Přehraje záznam jako `traceRun` a po úsecích sebere, co hráč viděl a jak
 * rychle jel. Hash na konci = hash přehrání. Hra s průběhem, jehož cíl není
 * trať, se měří v rovině (postup = `progressOf` cíle).
 */
export function segmentRun(world: ArcadeWorld, inputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY): SegmentRun {
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const player = state[HEADER.player] as number;
  const length = Math.max(1, world.length);
  const goal = goalOf(world.control);
  const plane = goal !== undefined && goal.by !== 'distance' ? goal : undefined;
  const born = Array.from({ length: ARCADE_LIMITS.maxBodies }, () => 0);
  const buckets: Bucket[] = SEGMENT_NAMES.map(() => ({ ticks: 0, from: Infinity, to: -Infinity, speeds: [], widths: [], seen: new Map() }));
  let reached = 0;
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const before = at(state, player, 'z');
    const count = state[HEADER.bodyCount] as number;
    const wasAlive = Array.from({ length: count }, (_, body) => alive(state, body));
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (body >= count || (!wasAlive[body] && alive(state, body))) born[body] = tick + 1;
    const z = at(state, player, 'z');
    reached = Math.max(reached, plane === undefined ? Math.min(1000, Math.max(0, Math.floor((z * 1000) / length))) : progressOf(state, plane));
    const bucket = buckets[segmentOf(reached)] as Bucket;
    bucket.ticks += 1;
    if (plane === undefined) {
      bucket.from = Math.min(bucket.from, before);
      bucket.to = Math.max(bucket.to, z);
      bucket.speeds.push(Math.max(0, z - before));
    }
    if ((state[HEADER.tick] as number) % SAMPLE_TICKS === 0) {
      observe(state, player, born, bucket, plane !== undefined);
      const width = plane === undefined ? widthAt(state, player) : null;
      if (width !== null) bucket.widths.push(width);
    }
  }
  releasePhysics(state);
  // Hustota: tělo patří úseku, ve kterém ho hráč uviděl poprvé.
  const owned = new Set<string>();
  const facts = buckets.map((bucket) => {
    const first = new Set([...bucket.seen.keys()].filter((key) => !owned.has(key) && !(bucket.seen.get(key) as Seen).ground));
    for (const key of first) owned.add(key);
    return factsOf(bucket, first);
  });
  const changes = [1, 2].map((k) => changesOf(facts[k - 1] as SegmentFacts, facts[k] as SegmentFacts, facts.slice(0, k)));
  return { segments: facts, changes, segmentChanges: changes.filter((list) => list.length > 0).length, outcome: outcomeOf(state), hash: hashArcade(state) };
}
