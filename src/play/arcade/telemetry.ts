/**
 * Telemetrie běhu robota (P45A T3) – měřidlo zábavy. Přehraje záznam vstupů
 * stejnou smyčkou jako `replay` a stav jen čte: po každém tiku porovná stav
 * s kopií z jeho začátku a z efektů tiku složí herní události, každých
 * `SAMPLE_TICKS` tiků zapíše polohu hráče a hrozeb. Nic není wall-clock a nic
 * se nezapíše do stavu, takže hash běhu je s telemetrií i bez ní stejný.
 *
 * Druhy událostí odpovídají vizuálním událostem scény (`effects/bus.ts`), kód
 * je vlastní – sběrnice patří scéně a jádro na scénu nesahá.
 */

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, ROLE, RUN_STATE, UNIT, bodyBase, bodyHp, targetStateOf } from './contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from './kernel';
import { ARCADE_LIBRARY } from './library';
import { releasePhysics } from './physics/step';
import { THING_ROLE_BASE } from './rules/compile';

/**
 * `pickup` = zmizela sebraná věc (role `collectible` nebo věc pravidel specu),
 * `kill` = zmizel nepřítel, hrozba nebo terč, `hit` = zásah ubral HP jinému tělu
 * (nebo ho zabil), `damage` = hráč přišel o život nebo HP, `spawn` = nové tělo,
 * `stateChange` = cíl přešel do jiného stavu, `score` = skóre stouplo,
 * `win` / `lose` = konec běhu.
 */
export const TRACE_EVENT_KINDS = ['pickup', 'kill', 'hit', 'damage', 'spawn', 'stateChange', 'score', 'win', 'lose'] as const;
export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export interface TraceEvent {
  /** Tik, který událost vydal (stav před ním měl `HEADER.tick` = `tick`). */
  readonly tick: number;
  readonly kind: TraceEventKind;
  /** Index těla; `damage`, `score`, `win` a `lose` patří hráči. */
  readonly body: number;
  /** Kód role těla (`ROLE`, věci pravidel od `THING_ROLE_BASE`). */
  readonly role: number;
}

/** Poloha těla ve vzorku, v jednotkách jádra (`UNIT` na metr); rychlost v jednotkách za tik. */
export interface TraceBody {
  readonly body: number;
  readonly role: number;
  /** Tik, kdy tělo v tomhle slotu ožilo (0 = žije od startu); slot znovu použitý spawnem je nové tělo. */
  readonly born: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Výška těla; `y` je spodní stěna, střed je o `h / 2` výš. */
  readonly h: number;
  readonly vx: number;
  readonly vz: number;
  /** HP těla (`bodyHp`); 0 = tělo HP nemá nebo je na nule. */
  readonly hp: number;
}

export interface TraceSample {
  /** `HEADER.tick` stavu, ze kterého je vzorek (0 = start, pak každých `SAMPLE_TICKS`, poslední = konec běhu). */
  readonly tick: number;
  readonly player: { readonly x: number; readonly y: number; readonly z: number; readonly h: number };
  /** Živá těla rolí `THREAT_ROLES`. */
  readonly bodies: readonly TraceBody[];
}

export interface RunTrace {
  /** Délka běhu v ticích (`HEADER.tick` na konci). */
  readonly ticks: number;
  readonly outcome: ArcadeOutcome;
  readonly hash: string;
  readonly player: number;
  readonly events: readonly TraceEvent[];
  readonly samples: readonly TraceSample[];
}

/** Rozestup vzorků poloh: 6 tiků = 0,1 s. */
export const SAMPLE_TICKS = 6;
/** Role, jejichž polohu vzorek nese: co hráče ohrožuje. */
export const THREAT_ROLES: readonly number[] = [ROLE.chaser, ROLE.enemy, ROLE.hazard, ROLE.projectile];
const KILL_ROLES: readonly number[] = [ROLE.chaser, ROLE.enemy, ROLE.hazard, ROLE.target];

const aliveIn = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const roleIn = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.role] as number;

/** Druh zmizení těla podle role; `null` = zmizení, které není herní událost (projektil, překážka). */
function despawnKind(role: number): 'pickup' | 'kill' | null {
  if (role === ROLE.collectible || role >= THING_ROLE_BASE) return 'pickup';
  return KILL_ROLES.includes(role) ? 'kill' : null;
}

/** Události jednoho tiku: `prev` = stav před tikem, `state` = po něm. Jedna na (tělo, druh). */
function eventsOf(effects: readonly ArcadeEffect[], tick: number, prev: Int32Array, state: Int32Array): TraceEvent[] {
  const player = state[HEADER.player] as number;
  const count = state[HEADER.bodyCount] as number;
  const events: TraceEvent[] = [];
  const seen = new Set<string>();
  const add = (kind: TraceEventKind, body: number): void => {
    const key = `${String(body)}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ tick, kind, body, role: roleIn(state, body) });
  };
  const inWorld = (body: number): boolean => body >= 0 && body < count;
  let spawned = false;
  for (const effect of effects) {
    if (effect.kind === 'spawn') spawned = true;
    else if (effect.kind === 'despawn' && inWorld(effect.body) && effect.body !== player && aliveIn(prev, effect.body) && !aliveIn(state, effect.body)) {
      const kind = despawnKind(roleIn(state, effect.body));
      if (kind !== null) add(kind, effect.body);
    } else if (effect.kind === 'hit' && effect.amount > 0 && inWorld(effect.body) && effect.body !== player && aliveIn(prev, effect.body)) {
      if (bodyHp(state, effect.body) < bodyHp(prev, effect.body) || !aliveIn(state, effect.body)) add('hit', effect.body);
    } else if (effect.kind === 'stateChange' && inWorld(effect.body) && targetStateOf(state, effect.body) !== targetStateOf(prev, effect.body)) add('stateChange', effect.body);
  }
  if (spawned) for (let body = state[HEADER.spawnBase] as number; body < count; body += 1) if (!aliveIn(prev, body) && aliveIn(state, body)) add('spawn', body);
  const health = HEADER.counters + COUNTER.health;
  if ((state[health] as number) < (prev[health] as number) || bodyHp(state, player) < bodyHp(prev, player)) add('damage', player);
  const score = HEADER.counters + COUNTER.score;
  if ((state[score] as number) > (prev[score] as number)) add('score', player);
  // Konec podle stavu, ne podle efektu: prohra v témže tiku výhru přebije (`settleRun` v jádře).
  if (prev[HEADER.runState] === RUN_STATE.running && state[HEADER.runState] === RUN_STATE.won) add('win', player);
  else if (prev[HEADER.runState] === RUN_STATE.running && state[HEADER.runState] === RUN_STATE.lost) add('lose', player);
  return events;
}

function sampleOf(state: Int32Array, born: readonly number[]): TraceSample {
  const p = bodyBase(state[HEADER.player] as number);
  const bodies: TraceBody[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (!aliveIn(state, body) || !THREAT_ROLES.includes(state[base + BODY.role] as number)) continue;
    bodies.push({ body, role: state[base + BODY.role] as number, born: born[body] as number, x: state[base + BODY.x] as number, y: state[base + BODY.y] as number, z: state[base + BODY.z] as number, h: state[base + BODY.h] as number, vx: state[base + BODY.vx] as number, vz: state[base + BODY.vz] as number, hp: bodyHp(state, body) });
  }
  return { tick: state[HEADER.tick] as number, player: { x: state[p + BODY.x] as number, y: state[p + BODY.y] as number, z: state[p + BODY.z] as number, h: state[p + BODY.h] as number }, bodies };
}

/**
 * Přehraje záznam jako `replay` (`kernel.ts`) a zapíše události a vzorky poloh.
 * Záznam je řídký a seřazený podle tiku; horizont je horizont ověření.
 */
export function traceRun(world: ArcadeWorld, inputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY): RunTrace {
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const prev = state.slice();
  const born = Array.from({ length: state[HEADER.bodyCount] as number }, () => 0);
  const events: TraceEvent[] = [];
  const samples: TraceSample[] = [sampleOf(state, born)];
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    prev.set(state);
    const effects = step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    // Spawn smí svět rozšířit do rezervy: nové sloty i znovu oživené rodí v tomhle tiku.
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (body >= (prev[HEADER.bodyCount] as number) || (!aliveIn(prev, body) && aliveIn(state, body))) born[body] = tick + 1;
    events.push(...eventsOf(effects, tick, prev, state));
    if ((state[HEADER.tick] as number) % SAMPLE_TICKS === 0) samples.push(sampleOf(state, born));
  }
  // Poslední vzorek je vždy konec běhu: zabití v tiku výhry mezi vzorky jinak nikdo neuvidí.
  if ((samples[samples.length - 1] as TraceSample).tick !== state[HEADER.tick]) samples.push(sampleOf(state, born));
  // Jako `replay`: běh, který dojel na horizont, uvolní svět Rapieru tady.
  releasePhysics(state);
  return { ticks: state[HEADER.tick] as number, outcome: outcomeOf(state), hash: hashArcade(state), player: state[HEADER.player] as number, events, samples };
}

// ---------------------------------------------------------------------------
// Čísla zábavy (P45A T4–T6)

export interface FunMetrics {
  /** Herní události za sekundu běhu (60 Hz). */
  readonly eventsPerS: number;
  /** Nejdelší a mediánová mezera mezi herními událostmi v sekundách, počítaje začátek a konec běhu. */
  readonly longestGapS: number;
  readonly medianGapS: number;
  /** Událostí v poslední třetině běhu / v první; `null` = první třetina bez události. */
  readonly intensityRatio: number | null;
  /** Poslední třetina má víc událostí než první (prázdná první a neprázdná poslední = stoupá). */
  readonly rising: boolean;
  /** Hrozba vešla do `NEAR_MISS_RADIUS` od středu hráče a vyšla ven, aniž hráč mezitím přišel o život. */
  readonly nearMisses: number;
  /** Počet událostí `damage`. */
  readonly livesLost: number;
  readonly playerDied: boolean;
  /** Počet událostí `kill`. */
  readonly kills: number;
  /** Seřazené různé podpisy `<role>:<motion>` hrozeb (`+spawned` = tělo vzniklo po startu); vlastní střely hráče nevstupují. */
  readonly behaviours: readonly string[];
  readonly behaviourCount: number;
  readonly finale: Finale;
}

/** `boss` = hrozba dostala ≥ `BOSS_HITS` zásahů a do konce zmizela; `climax` = vyhraný běh zhoustl na konci. */
export interface Finale {
  readonly present: boolean;
  readonly why: 'boss' | 'climax' | null;
}

/** Poloměr blízkého minutí v jednotkách jádra: 1,5 m. */
export const NEAR_MISS_RADIUS = 1.5 * UNIT;

type Centred = { readonly x: number; readonly y: number; readonly z: number; readonly h: number };
const centreDistanceSq = (a: Centred, b: Centred): number => (a.x - b.x) ** 2 + (a.y + a.h / 2 - b.y - b.h / 2) ** 2 + (a.z - b.z) ** 2;

/**
 * Epizody blízkého minutí ze vzorků poloh. Tělo je (slot, tik vzniku): slot
 * znovu použitý spawnem je nová hrozba. Vstup = vzorek uvnitř po vzorku venku –
 * tělo zrozené uvnitř (vlastní střela hráče) nevstoupilo. Epizoda končí prvním
 * vzorkem venku; tělo, které zmizelo uvnitř, ven nevyšlo. Zásah hráče od
 * posledního vzorku venku do konce epizody ji zruší.
 */
function nearMissesOf(trace: RunTrace): number {
  // `damage` v tiku t je ve stavu s `HEADER.tick` = t + 1 – stejná osa jako vzorky.
  const hits = trace.events.filter((e) => e.kind === 'damage').map((e) => e.tick + 1);
  const outsideAt = new Map<string, number>();
  const open = new Map<string, number>();
  let count = 0;
  for (const sample of trace.samples) {
    const present = new Set<string>();
    for (const body of sample.bodies) {
      const key = `${String(body.body)}@${String(body.born)}`;
      present.add(key);
      if (centreDistanceSq(body, sample.player) < NEAR_MISS_RADIUS ** 2) {
        const from = outsideAt.get(key);
        if (!open.has(key) && from !== undefined) open.set(key, from);
        continue;
      }
      const from = open.get(key);
      if (from !== undefined && !hits.some((tick) => tick > from && tick <= sample.tick)) count += 1;
      open.delete(key);
      outsideAt.set(key, sample.tick);
    }
    for (const key of [...open.keys()]) if (!present.has(key)) open.delete(key);
  }
  return count;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Tiky herních událostí, seřazené. Konec běhu (`win`/`lose`) je hrana poslední
 * mezery, ne událost; skóre v tiku jiné události je její následek, ne druhá
 * událost (sebrání + skóre = jedna); samotné skóre (rytmus, souboj) se počítá.
 */
function gameEventTicks(trace: RunTrace): number[] {
  const busy = new Set(trace.events.filter((e) => e.kind !== 'score' && e.kind !== 'win' && e.kind !== 'lose').map((e) => e.tick));
  return trace.events.filter((e) => e.kind !== 'win' && e.kind !== 'lose' && !(e.kind === 'score' && busy.has(e.tick))).map((e) => e.tick).sort((a, b) => a - b);
}

/** Tělo, které za běh ujede méně, stojí: 0,5 m. */
export const STATIC_PATH = 0.5 * UNIT;
/** Projektil poprvé viděný blíž k hráči a letící od něj je hráčova vlastní střela: 3 m. */
export const OWN_SHOT_RADIUS = 3 * UNIT;
/** Honí = průměrný kosinus posunu k hráči nad tímhle prahem. */
export const CHASE_COSINE = 0.5;
export const BOSS_HITS = 3;
/** Finále stupňováním: posledních 10 s vyhraného běhu je aspoň 1,5× hustší než celý běh. */
export const CLIMAX_TICKS = 10 * ARCADE_HZ;
export const CLIMAX_FACTOR = 1.5;
const BOSS_ROLES: readonly number[] = [ROLE.chaser, ROLE.enemy, ROLE.hazard];
const ROLE_NAME = new Map<number, string>(Object.entries(ROLE).map(([name, code]) => [code, name]));

/** Jedno tělo (slot, tik vzniku) napříč vzorky, s polohou hráče v každém. */
interface Track {
  readonly body: number;
  readonly role: number;
  readonly born: number;
  readonly points: { readonly at: TraceBody; readonly player: TraceSample['player'] }[];
}

function tracksOf(trace: RunTrace): Track[] {
  const tracks = new Map<string, Track>();
  for (const sample of trace.samples) {
    for (const body of sample.bodies) {
      const key = `${String(body.body)}@${String(body.born)}`;
      const track = tracks.get(key) ?? { body: body.body, role: body.role, born: body.born, points: [] };
      track.points.push({ at: body, player: sample.player });
      tracks.set(key, track);
    }
  }
  return [...tracks.values()];
}

/** Hráčova střela: poprvé viděná do `OWN_SHOT_RADIUS` od hráče a letí od něj. */
function ownShot(track: Track): boolean {
  if (track.role !== ROLE.projectile) return false;
  const { at, player } = track.points[0] as Track['points'][number];
  const dx = at.x - player.x;
  const dz = at.z - player.z;
  return dx * dx + dz * dz < OWN_SHOT_RADIUS ** 2 && at.vx * dx + at.vz * dz > 0;
}

/** `static` podle dráhy, `chase` podle průměrného kosinu posunu mezi vzorky k hráči (vodorovně), jinak `roam`. */
function motionOf(track: Track): 'shot' | 'static' | 'chase' | 'roam' {
  if (track.role === ROLE.projectile) return 'shot';
  let path = 0;
  let cosines = 0;
  let moves = 0;
  for (let i = 1; i < track.points.length; i += 1) {
    const { at: from, player } = track.points[i - 1] as Track['points'][number];
    const to = (track.points[i] as Track['points'][number]).at;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    path += Math.hypot(dx, to.y - from.y, dz);
    const step = Math.hypot(dx, dz);
    const towards = Math.hypot(player.x - from.x, player.z - from.z);
    if (step === 0 || towards === 0) continue;
    cosines += (dx * (player.x - from.x) + dz * (player.z - from.z)) / (step * towards);
    moves += 1;
  }
  if (path < STATIC_PATH) return 'static';
  return moves > 0 && cosines / moves > CHASE_COSINE ? 'chase' : 'roam';
}

function behavioursOf(tracks: readonly Track[]): string[] {
  const signatures = new Set(tracks.filter((t) => !ownShot(t)).map((t) => `${ROLE_NAME.get(t.role) ?? String(t.role)}:${motionOf(t)}${t.born > 0 ? '+spawned' : ''}`));
  return [...signatures].sort();
}

/**
 * Boss: hrozba (slot, tik vzniku) s ≥ `BOSS_HITS` zásahy, která do konce zmizela –
 * `kill`, chybí v posledním vzorku, nebo tam má HP 0 (poražený v souboji v aréně
 * zůstává ve hře). Událost patří tělu slotu s nejpozdějším vznikem ≤ jejímu tiku.
 */
function hasBoss(trace: RunTrace, tracks: readonly Track[]): boolean {
  const owner = (event: TraceEvent): Track | undefined =>
    tracks.filter((t) => t.body === event.body && t.born <= event.tick).reduce<Track | undefined>((best, t) => (best === undefined || t.born > best.born ? t : best), undefined);
  const hits = new Map<Track, number>();
  const killed = new Set<Track>();
  for (const event of trace.events) {
    if (event.kind !== 'hit' && event.kind !== 'kill') continue;
    const track = owner(event);
    if (track === undefined) continue;
    if (event.kind === 'kill') killed.add(track);
    else hits.set(track, (hits.get(track) ?? 0) + 1);
  }
  const last = trace.samples[trace.samples.length - 1]?.bodies ?? [];
  const goneAtEnd = (t: Track): boolean => !last.some((b) => b.body === t.body && b.born === t.born && b.hp > 0);
  return tracks.some((t) => BOSS_ROLES.includes(t.role) && (hits.get(t) ?? 0) >= BOSS_HITS && (killed.has(t) || goneAtEnd(t)));
}

/** Climax: vyhraný běh delší než `CLIMAX_TICKS`, jehož posledních `CLIMAX_TICKS` je ≥ `CLIMAX_FACTOR` × hustota běhu. */
function hasClimax(trace: RunTrace, ticks: readonly number[]): boolean {
  if (trace.outcome !== 'won' || trace.ticks <= CLIMAX_TICKS) return false;
  const late = ticks.filter((tick) => tick >= trace.ticks - CLIMAX_TICKS).length;
  return late > 0 && late / CLIMAX_TICKS >= (CLIMAX_FACTOR * ticks.length) / trace.ticks;
}

export function funMetrics(trace: RunTrace): FunMetrics {
  const ticks = gameEventTicks(trace);
  const seconds = trace.ticks / ARCADE_HZ;
  const edges = [0, ...ticks, trace.ticks];
  const gaps = edges.slice(1).map((tick, i) => (tick - (edges[i] as number)) / ARCADE_HZ);
  // Třetiny délky tohohle běhu, ne horizontu ověření: hra vyhraná za 30 s má třetiny po 10 s.
  const first = ticks.filter((tick) => tick < trace.ticks / 3).length;
  const last = ticks.filter((tick) => tick >= (2 * trace.ticks) / 3).length;
  const tracks = tracksOf(trace);
  const behaviours = behavioursOf(tracks);
  const why = hasBoss(trace, tracks) ? 'boss' : hasClimax(trace, ticks) ? 'climax' : null;
  return {
    eventsPerS: seconds === 0 ? 0 : round2(ticks.length / seconds),
    longestGapS: round2(Math.max(...gaps)),
    medianGapS: round2(median(gaps)),
    intensityRatio: first === 0 ? null : round2(last / first),
    rising: last > first,
    nearMisses: nearMissesOf(trace),
    livesLost: trace.events.filter((e) => e.kind === 'damage').length,
    playerDied: trace.outcome === 'lost',
    kills: trace.events.filter((e) => e.kind === 'kill').length,
    behaviours,
    behaviourCount: behaviours.length,
    finale: { present: why !== null, why },
  };
}
