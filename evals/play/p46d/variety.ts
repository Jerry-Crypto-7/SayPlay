/**
 * Měřidlo rozmanitosti tratí P46D (T1). Majitel 12. 10.: „hry jsou si podobné“ –
 * běžec je rovná trať se třemi pruhy, řízení boční posuny středu a skákačka tři
 * úseky stejného druhu.
 *
 * Podpis tvaru se počítá z těles hotového světa, ne ze jmen modelů: rozměry,
 * pruhy, mezery, zdi. Jiný model, barva nebo jméno druhu podpis nepohne
 * (kosmetika se nepočítá). Vzory se poznávají ze struktury, ne ze štítků
 * generátoru, takže měřidlo nevěří tomu, co o sobě generátor tvrdí.
 *
 * - Běžec: řady překážek (které pruhy jsou volné a jak se překážka míjí – skok,
 *   skluz, jen jiným pruhem), dlouhé zdi (rozcestí, most, tunel), věci v řadě
 *   přes pruhy a volné úseky. Křivka a výška trati ze scény (T3, `trackPathOf`).
 * - Řízení: úseky mezi mantinely – dlouhé a krátké zatáčky, šikany, zúžení,
 *   rozcestí a rovinky s turbem.
 * - Skákačka: kroky mezi plošinami – schody, výstup, rostoucí mezery, hroty,
 *   pohyblivé plošiny, voda a odpočinek u checkpointu.
 *
 * Vzdálenost dvou podpisů téhož žánru je 0–1: polovina rozdíl zastoupení vzorů,
 * polovina rozdíl dvojic sousedních vzorů (obojí total variation). Křivka a výška
 * běžce se do průměru přidají, když je aspoň jeden podpis má.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { runnerPathOf } from '@/components/play/arcade/runner/path';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

export const P46D_DIR = join(process.cwd(), 'evals', 'play', 'p46d');

export const VARIETY_GENRES = ['runner', 'steer', 'platform'] as const;
export type VarietyGenre = (typeof VARIETY_GENRES)[number];

export interface VarietySentence {
  readonly id: string;
  readonly genre: VarietyGenre;
  readonly text: string;
}

/**
 * Práh „jiný tvar“. Kalibrace T1: dvě semínka téže věty na dnešním běžci dají 0,
 * ručně různé tratě 1. Práh 0,3 = zhruba třetina vzorů nebo jejich pořadí jinak.
 */
export const SHAPE_THRESHOLD = 0.3;

/** Tělo světa jen s tím, co nese tvar: role, poloha a rozměry. Druh (model) se nečte. */
export interface ShapeBody {
  readonly role: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly kinematic: boolean;
}

export interface Signature {
  readonly genre: VarietyGenre;
  /** Vzory po trati v pořadí `z`; sousední stejné jsou sloučené. */
  readonly motifs: readonly string[];
  /** Křivka a výška trati běžce po `PATH_BINS` dílech (`L`/`R`/`S`, `U`/`D`/`F`); prázdné = trať bez křivky. */
  readonly curve: readonly string[];
  readonly height: readonly string[];
  readonly forks: number;
  readonly chicanes: number;
  readonly narrowings: number;
}

/** Bod osy trati v jednotkách světa (`x` do strany, `y` nahoru) – vizuální křivka běžce (T3). */
export type TrackPath = (z: number) => { readonly x: number; readonly y: number };

/** Křivka, kterou scéna kreslí (`runnerPathOf`, metry), v jednotkách světa; jiný žánr žádnou nemá. */
export function trackPathOf(world: ArcadeWorld): TrackPath | undefined {
  const path = runnerPathOf(world);
  if (path === null) return undefined;
  return (z) => {
    const point = path(z / UNIT);
    return { x: point.x * UNIT, y: point.y * UNIT };
  };
}

/** Živá tělesa počátečního stavu. Mrtvé předlohy (spawn, boss) se do tvaru nepočítají. */
export function bodiesOf(world: ArcadeWorld): ShapeBody[] {
  const state = instantiate(world);
  const count = state[HEADER.bodyCount] as number;
  const bodies: ShapeBody[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if ((flags & FLAG.alive) === 0) continue;
    const at = (slot: keyof typeof BODY): number => state[base + BODY[slot]] as number;
    bodies.push({ role: at('role'), x: at('x'), y: at('y'), z: at('z'), w: at('w'), h: at('h'), d: at('d'), kinematic: (flags & FLAG.kinematic) !== 0 });
  }
  return bodies;
}

interface Event {
  readonly z: number;
  readonly motif: string;
}

/** Vzory seřazené po trati, sousední stejné sloučené. */
function sequence(events: readonly Event[]): string[] {
  const sorted = [...events].sort((a, b) => a.z - b.z);
  return sorted.map((event) => event.motif).filter((motif, index, all) => index === 0 || all[index - 1] !== motif);
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] as number);
};

// ---------------------------------------------------------------- běžec

/** Těleso delší než tohle je zeď (rozcestí, most, tunel), ne překážka v řadě. */
const LONG = 5 * UNIT;

/** Jak se překážka míjí, z rozměrů: nad zemí = skluz, nízká = skok, jinak jen jiným pruhem. */
const passOf = (body: ShapeBody): 'S' | 'J' | 'L' => (body.y > 0 ? 'S' : body.h <= UNIT ? 'J' : 'L');

const laneOf = (x: number): number => Math.max(-1, Math.min(1, Math.round(x / RUNNER.laneWidth)));

interface Row {
  readonly z: number;
  /** Pruhy −1, 0, 1: `.` volno, `J` skok, `S` skluz, `L` jen jiným pruhem. */
  readonly lanes: readonly string[];
}

const openLanes = (row: Row): number[] => row.lanes.flatMap((lane, index) => (lane === '.' ? [index - 1] : []));
const count = (row: Row, pass: string): number => row.lanes.filter((lane) => lane === pass).length;
const blocked = (row: Row): boolean => openLanes(row).length === 0;

/** Kolik řad od `from` splní `fits` (s předchozí řadou běhu), nebo 0. */
function run(rows: readonly Row[], from: number, fits: (row: Row, prev: Row | undefined) => boolean): number {
  let to = from;
  while (to < rows.length && fits(rows[to] as Row, to === from ? undefined : rows[to - 1])) to += 1;
  return to - from;
}

/** Vzory řad v jednom běhu bez zdí: cik-cak, řetěz skoků, ulička skluzu, jinak `mixed`. */
function rowMotifs(rows: readonly Row[]): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i] as Row;
    // Cik-cak: jediný volný pruh na kraji a každou řadu na opačném.
    const zigzag = run(rows, i, (r, prev) => {
      const open = openLanes(r);
      return open.length === 1 && open[0] !== 0 && (prev === undefined || openLanes(prev)[0] === -(open[0] as number));
    });
    const jumps = run(rows, i, (r) => blocked(r) && count(r, 'J') >= 2);
    const slides = run(rows, i, (r) => blocked(r) && count(r, 'S') >= 2);
    const [motif, length] = zigzag >= 4 ? ['zigzag', zigzag] : jumps >= 3 ? ['jump-chain', jumps] : slides >= 3 ? ['slide-alley', slides] : ['mixed', 1];
    events.push({ z: row.z, motif });
    i += length as number;
  }
  return events;
}

function runnerSignature(bodies: readonly ShapeBody[]): Pick<Signature, 'motifs' | 'forks'> {
  const obstacles = bodies.filter((body) => body.role === ROLE.obstacle);
  // Zdi: překrývající se dlouhá tělesa tvoří jeden útvar.
  const walls = obstacles.filter((body) => body.d >= LONG).sort((a, b) => a.z - a.d / 2 - (b.z - b.d / 2));
  const clusters: { near: number; far: number; members: ShapeBody[] }[] = [];
  for (const wall of walls) {
    const near = wall.z - wall.d / 2;
    const far = wall.z + wall.d / 2;
    const last = clusters[clusters.length - 1];
    if (last !== undefined && near < last.far) {
      last.far = Math.max(last.far, far);
      last.members.push(wall);
    } else clusters.push({ near, far, members: [wall] });
  }
  const events: Event[] = [];
  let forks = 0;
  for (const cluster of clusters) {
    const lanes = new Set(cluster.members.map((wall) => laneOf(wall.x)));
    const motif = cluster.members.some((wall) => wall.y > 0) ? 'tunnel' : lanes.has(-1) && lanes.has(1) ? 'bridge' : lanes.has(0) ? 'fork' : 'wall';
    if (motif === 'fork') forks += 1;
    events.push({ z: cluster.near, motif });
  }

  const byZ = new Map<number, string[]>();
  for (const body of obstacles) {
    if (body.d >= LONG) continue;
    const lanes = byZ.get(body.z) ?? ['.', '.', '.'];
    const index = laneOf(body.x) + 1;
    const pass = passOf(body);
    lanes[index] = lanes[index] === '.' || pass === 'L' ? pass : (lanes[index] as string);
    byZ.set(body.z, lanes);
  }
  const rows = [...byZ.entries()].map(([z, lanes]) => ({ z, lanes })).sort((a, b) => a.z - b.z);
  const inside = (z: number): boolean => clusters.some((cluster) => z >= cluster.near && z <= cluster.far);
  // Řady mezi zdmi patří zdi; zbylé řady se čtou po bězích mezi útvary.
  let open: Row[] = [];
  for (const row of rows) {
    if (inside(row.z)) {
      events.push(...rowMotifs(open));
      open = [];
    } else open.push(row);
  }
  events.push(...rowMotifs(open));

  // Volný úsek: mezera mezi řadami přes 2,2× medián (bez zdi uvnitř).
  const gaps = rows.slice(1).map((row, index) => ({ from: (rows[index] as Row).z, to: row.z }));
  const typical = median(gaps.map((gap) => gap.to - gap.from));
  for (const gap of gaps) {
    const spansWall = clusters.some((cluster) => cluster.near < gap.to && cluster.far > gap.from);
    if (typical > 0 && gap.to - gap.from > 2.2 * typical && !spansWall) events.push({ z: gap.from + 1, motif: 'sprint' });
  }

  // Stezka věcí: aspoň pět věcí za sebou (rozestup do 4 m) přes víc pruhů.
  const items = bodies.filter((body) => body.role === ROLE.collectible).sort((a, b) => a.z - b.z);
  for (let i = 0; i < items.length; ) {
    let j = i + 1;
    while (j < items.length && (items[j] as ShapeBody).z - (items[j - 1] as ShapeBody).z <= 4 * UNIT) j += 1;
    const trail = items.slice(i, j);
    if (trail.length >= 5 && new Set(trail.map((item) => laneOf(item.x))).size >= 2) events.push({ z: (trail[0] as ShapeBody).z, motif: 'trail' });
    i = j;
  }
  return { motifs: sequence(events), forks };
}

// ---------------------------------------------------------------- řízení

interface Segment {
  readonly near: number;
  readonly far: number;
  readonly center: number;
  readonly width: number;
}

function steerSignature(bodies: readonly ShapeBody[]): Pick<Signature, 'motifs' | 'forks' | 'chicanes' | 'narrowings'> {
  // Mantinely: dvojice dlouhých těles se stejným `z` a `d`; třetí mezi nimi je dělicí ostrůvek.
  const long = bodies.filter((body) => body.role === ROLE.obstacle && body.d >= LONG);
  const groups = new Map<string, ShapeBody[]>();
  for (const body of long) groups.set(`${body.z}/${body.d}`, [...(groups.get(`${body.z}/${body.d}`) ?? []), body]);
  const segments: Segment[] = [];
  const dividers: ShapeBody[] = [];
  for (const walls of groups.values()) {
    if (walls.length < 2) continue;
    const sorted = [...walls].sort((a, b) => a.x - b.x);
    const left = sorted[0] as ShapeBody;
    const right = sorted[sorted.length - 1] as ShapeBody;
    const inner = left.x + left.w / 2;
    const outer = right.x - right.w / 2;
    segments.push({ near: left.z - left.d / 2, far: left.z + left.d / 2, center: Math.floor((inner + outer) / 2), width: outer - inner });
    dividers.push(...sorted.slice(1, -1));
  }
  segments.sort((a, b) => a.near - b.near);
  // Osamělé dlouhé těleso uvnitř silnice je taky ostrůvek rozcestí.
  for (const walls of groups.values()) {
    if (walls.length !== 1) continue;
    const body = walls[0] as ShapeBody;
    const host = segments.find((segment) => body.z >= segment.near && body.z <= segment.far);
    if (host !== undefined && Math.abs(body.x - host.center) < host.width / 2) dividers.push(body);
  }

  const events: Event[] = [];
  const typical = median(segments.map((segment) => segment.width));
  let narrowings = 0;
  segments.forEach((segment, index) => {
    const narrow = segment.width <= 0.8 * typical;
    if (narrow && !(index > 0 && (segments[index - 1] as Segment).width <= 0.8 * typical)) {
      narrowings += 1;
      events.push({ z: segment.near + 1, motif: 'narrow' });
    }
  });
  const forkZs = [...new Set(dividers.map((divider) => segments.findIndex((segment) => divider.z >= segment.near && divider.z <= segment.far)))];
  for (const index of forkZs) if (index >= 0) events.push({ z: (segments[index] as Segment).near + 2, motif: 'fork' });

  // Běhy úseků: zatáčka = posuny středu stejným směrem, rovinka = bez posunu.
  interface Piece { readonly dir: number; readonly from: number; readonly to: number }
  const pieces: Piece[] = [];
  segments.forEach((segment, index) => {
    const dir = index === 0 ? 0 : Math.sign(segment.center - (segments[index - 1] as Segment).center);
    const last = pieces[pieces.length - 1];
    if (last !== undefined && last.dir === dir) pieces[pieces.length - 1] = { ...last, to: index };
    else pieces.push({ dir, from: index, to: index });
  });
  const turbos = bodies.filter((body) => body.role === ROLE.collectible);
  let chicanes = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i] as Piece;
    const near = (segments[piece.from] as Segment).near;
    const far = (segments[piece.to] as Segment).far;
    const size = piece.to - piece.from + 1;
    if (piece.dir === 0) {
      events.push({ z: near, motif: turbos.some((turbo) => turbo.z >= near && turbo.z <= far) ? 'turbo-straight' : 'straight' });
      continue;
    }
    // Šikana: krátká zatáčka a hned (nejvýš 15 m rovně) krátká zatáčka na druhou stranu.
    const between = pieces[i + 1]?.dir === 0 ? pieces[i + 1] : undefined;
    const next = pieces[i + (between === undefined ? 1 : 2)];
    const gap = between === undefined ? 0 : (segments[between.to] as Segment).far - (segments[between.from] as Segment).near;
    if (size <= 3 && next !== undefined && next.dir === -piece.dir && next.to - next.from + 1 <= 3 && gap <= 15 * UNIT) {
      chicanes += 1;
      events.push({ z: near, motif: 'chicane' });
      i += between === undefined ? 1 : 2;
      continue;
    }
    events.push({ z: near, motif: size >= 5 ? 'sweep' : 'kink' });
  }
  return { motifs: sequence(events), forks: forkZs.filter((index) => index >= 0).length, chicanes, narrowings };
}

// ---------------------------------------------------------------- skákačka

interface Slab {
  readonly near: number;
  readonly far: number;
  readonly top: number;
  readonly moving: boolean;
  readonly spikes: number;
  readonly checkpoint: boolean;
}

function platformSignature(bodies: readonly ShapeBody[]): Pick<Signature, 'motifs'> {
  const hazards = bodies.filter((body) => body.role === ROLE.hazard);
  const checkpoints = bodies.filter((body) => body.role === ROLE.checkpoint);
  const on = (body: ShapeBody, near: number, far: number, top: number): boolean => body.z > near && body.z < far && body.y === top;
  const slabs: Slab[] = bodies
    .filter((body) => body.role === ROLE.platform)
    .map((body) => {
      const near = body.z - body.d / 2;
      const far = body.z + body.d / 2;
      const top = body.y + body.h;
      return { near, far, top, moving: body.kinematic, spikes: hazards.filter((hazard) => on(hazard, near, far, top)).length, checkpoint: checkpoints.some((cp) => on(cp, near, far, top)) };
    })
    .sort((a, b) => a.near - b.near);
  const events: Event[] = [];
  // Hrot mimo plošinu leží v mezeře: voda nebo jáma pod skokem.
  for (const hazard of hazards) if (!slabs.some((slab) => on(hazard, slab.near, slab.far, slab.top))) events.push({ z: hazard.z, motif: 'water' });
  // Překážka (tůň) v mezeře pod vršky obou desek kolem je voda pod skokem taky.
  for (const pool of bodies.filter((body) => body.role === ROLE.obstacle)) {
    const next = slabs.findIndex((slab, k) => k > 0 && pool.z > (slabs[k - 1] as Slab).far && pool.z < slab.near);
    if (next > 0 && pool.y + pool.h < Math.min((slabs[next - 1] as Slab).top, (slabs[next] as Slab).top)) events.push({ z: pool.z, motif: 'water' });
  }
  for (const slab of slabs) {
    if (slab.moving) events.push({ z: slab.near, motif: 'moving' });
    if (slab.checkpoint) events.push({ z: slab.near, motif: 'rest' });
  }

  const short = (slab: Slab): boolean => slab.far - slab.near <= 3.5 * UNIT;
  const step = (index: number): { gap: number; dh: number } => ({ gap: (slabs[index] as Slab).near - (slabs[index - 1] as Slab).far, dh: (slabs[index] as Slab).top - (slabs[index - 1] as Slab).top });
  /** Kolik kroků od `from` (krok `i` = ze desky `i − 1` na desku `i`) splní `fits`. */
  const steps = (from: number, fits: (index: number) => boolean): number => {
    let to = from;
    while (to < slabs.length && !(slabs[to] as Slab).moving && fits(to)) to += 1;
    return to - from;
  };
  for (let i = 1; i < slabs.length; ) {
    const stairs = steps(i, (k) => step(k).gap <= 1.2 * UNIT && Math.abs(step(k).dh) >= 400 && Math.sign(step(k).dh) === Math.sign(step(i).dh));
    const climb = steps(i, (k) => step(k).dh > 0);
    const rise = Array.from({ length: climb }, (_, k) => step(i + k).dh).reduce((sum, dh) => sum + dh, 0);
    const ramp = steps(i, (k) => short(slabs[k] as Slab) && (k === i || step(k).gap >= step(k - 1).gap + 300));
    const corridor = steps(i, (k) => (slabs[k] as Slab).spikes > 0);
    const [motif, length] =
      stairs >= 3 ? ['stairs', stairs]
      : climb >= 5 && rise >= 2400 ? ['climb', climb]
      : ramp >= 3 ? ['gap-ramp', ramp]
      : corridor >= 2 || (slabs[i] as Slab).spikes >= 2 ? ['spike-corridor', Math.max(1, corridor)]
      : (slabs[i] as Slab).moving ? ['moving', 1]
      : ['mixed', 1];
    events.push({ z: (slabs[i] as Slab).near, motif });
    i += length as number;
  }
  return { motifs: sequence(events) };
}

// ---------------------------------------------------------------- podpis a vzdálenost

/** Na kolik dílů se dělí křivka a výška trati běžce. */
export const PATH_BINS = 24;

function pathTokens(path: TrackPath, length: number): { curve: string[]; height: string[] } {
  const curve: string[] = [];
  const height: string[] = [];
  for (let bin = 0; bin < PATH_BINS; bin += 1) {
    const from = path((length * bin) / PATH_BINS);
    const to = path((length * (bin + 1)) / PATH_BINS);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    curve.push(dx > UNIT ? 'R' : dx < -UNIT ? 'L' : 'S');
    height.push(dy > UNIT / 2 ? 'U' : dy < -UNIT / 2 ? 'D' : 'F');
  }
  return { curve, height };
}

/** Podpis z těles; `path` je vizuální křivka běžce (T3), bez ní trať rovná. */
export function signatureOfBodies(genre: VarietyGenre, bodies: readonly ShapeBody[], length: number, path?: TrackPath): Signature {
  const empty = { forks: 0, chicanes: 0, narrowings: 0, curve: [] as string[], height: [] as string[] };
  if (genre === 'steer') return { genre, ...empty, ...steerSignature(bodies) };
  if (genre === 'platform') return { genre, ...empty, ...platformSignature(bodies) };
  const tokens = path === undefined ? { curve: [], height: [] } : pathTokens(path, length);
  // Rovná trať se křivkou nepočítá: podpis bez ní je týž jako bez scény.
  const flat = tokens.curve.every((token) => token === 'S') && tokens.height.every((token) => token === 'F');
  return { genre, ...empty, ...runnerSignature(bodies), ...(flat ? {} : tokens) };
}

export const signatureOf = (world: ArcadeWorld, genre: VarietyGenre, path?: TrackPath): Signature => signatureOfBodies(genre, bodiesOf(world), world.length, path);

function shares(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1 / tokens.length);
  return out;
}

/** Total variation: 0 = stejné zastoupení, 1 = nic společného; dvě prázdná = 0. */
function variation(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  const pa = shares(a);
  const pb = shares(b);
  let sum = 0;
  for (const key of new Set([...pa.keys(), ...pb.keys()])) sum += Math.abs((pa.get(key) ?? 0) - (pb.get(key) ?? 0));
  return sum / 2;
}

const pairsOf = (tokens: readonly string[]): string[] => tokens.slice(1).map((token, index) => `${tokens[index]}>${token}`);

/** Podíl dílů, kde se dvě křivky liší; chybějící křivka je rovná (`flat`). */
function mismatch(a: readonly string[], b: readonly string[], flat: string): number {
  let differ = 0;
  for (let bin = 0; bin < PATH_BINS; bin += 1) if ((a[bin] ?? flat) !== (b[bin] ?? flat)) differ += 1;
  return differ / PATH_BINS;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Vzdálenost dvou podpisů téhož žánru, 0–1. */
export function shapeDistance(a: Signature, b: Signature): number {
  if (a.genre !== b.genre) throw new Error(`p46d: cannot compare a ${a.genre} with a ${b.genre}`);
  const layout = (variation(a.motifs, b.motifs) + variation(pairsOf(a.motifs), pairsOf(b.motifs))) / 2;
  if (a.curve.length === 0 && b.curve.length === 0) return round3(layout);
  const path = (mismatch(a.curve, b.curve, 'S') + mismatch(a.height, b.height, 'F')) / 2;
  return round3((layout + path) / 2);
}

// ---------------------------------------------------------------- věty a hry

export function varietySentences(dir = P46D_DIR): VarietySentence[] {
  const corpus = JSON.parse(readFileSync(join(dir, 'sentences.json'), 'utf8')) as { sentences: VarietySentence[] };
  return corpus.sentences;
}

/** Ovládání, které žánr měřidla staví. */
const CONTROL_OF: Readonly<Record<VarietyGenre, string>> = { runner: 'runner', steer: 'steer', platform: 'platform' };

export const draftOf = (text: string): GameSpecV1 => draftGameSpecWithMeta(text, 1).spec;

export interface VarietyGame {
  readonly id: string;
  readonly genre: VarietyGenre;
  /** Semínko, které vybere publikace (`derivedSeeds`), nebo `null`. */
  readonly seed: number | null;
  readonly playable: boolean;
  readonly world: ArcadeWorld | null;
  readonly issues: readonly string[];
}

/** Hra věty jako z `/play`: rychlý návrh a první semínko, na kterém robot vyhraje a nečinný hráč ne. */
export async function publishedGame(sentence: VarietySentence): Promise<VarietyGame> {
  const spec = draftOf(sentence.text);
  const dead = (issues: readonly string[]): VarietyGame => ({ id: sentence.id, genre: sentence.genre, seed: null, playable: false, world: null, issues });
  if (spec.control !== CONTROL_OF[sentence.genre]) return dead([`the draft chose the ${spec.control ?? 'grid'} control, not ${CONTROL_OF[sentence.genre]}`]);
  await preloadPhysics(spec, loadRapier);
  let last: { seed: number; world: ArcadeWorld } | null = null;
  for (const seed of derivedSeeds(seedFrom(sentence.text.trim()))) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) return dead(made.issues);
    last = { seed, world: made.world };
    const verdict = verifyArcade(made.world);
    if (verdict.bot.outcome === 'won' && verdict.idle.outcome !== 'won') return { id: sentence.id, genre: sentence.genre, seed, playable: true, world: made.world, issues: [] };
  }
  // Nehratelná hra se změří taky (hráč ji může dostat).
  return { id: sentence.id, genre: sentence.genre, seed: last?.seed ?? null, playable: false, world: last?.world ?? null, issues: ['no seed passed the robot'] };
}

/** Svět věty na daném semínku, bez robota (kalibrace „dvě semínka téže věty“). */
export function worldOn(text: string, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(draftOf(text), seed);
  if (!made.ok) throw new Error(`p46d: "${text}" on seed ${seed}: ${made.issues.join('; ')}`);
  return made.world;
}

export interface VarietyPair {
  readonly a: string;
  readonly b: string;
  readonly genre: VarietyGenre;
  readonly distance: number;
  readonly different: boolean;
}

/** Všechny dvojice vět téhož žánru, které mají podpis. */
export function varietyPairs(rows: readonly { readonly id: string; readonly genre: VarietyGenre; readonly signature: Signature | null }[]): VarietyPair[] {
  const pairs: VarietyPair[] = [];
  rows.forEach((a, i) => {
    for (const b of rows.slice(i + 1)) {
      if (a.genre !== b.genre || a.signature === null || b.signature === null) continue;
      const distance = shapeDistance(a.signature, b.signature);
      pairs.push({ a: a.id, b: b.id, genre: a.genre, distance, different: distance > SHAPE_THRESHOLD });
    }
  });
  return pairs;
}

/** Podíl dvojic nad prahem, celkem a po žánrech. */
export function differentShare(pairs: readonly VarietyPair[]): { readonly all: number | null } & Partial<Record<VarietyGenre, number | null>> {
  const share = (list: readonly VarietyPair[]): number | null => (list.length === 0 ? null : round3(list.filter((pair) => pair.different).length / list.length));
  return { all: share(pairs), ...Object.fromEntries(VARIETY_GENRES.map((genre) => [genre, share(pairs.filter((pair) => pair.genre === genre))])) };
}

// ---------------------------------------------------------------- kalibrace

const obstacle = (lane: number, z: number, pass: 'J' | 'S' | 'L', d = 300): ShapeBody => ({
  role: ROLE.obstacle,
  x: lane * RUNNER.laneWidth,
  y: pass === 'S' ? 1000 : 0,
  z,
  w: 1600,
  h: pass === 'J' ? 600 : pass === 'S' ? 400 : 1500,
  d,
  kinematic: false,
});

const coin = (lane: number, z: number): ShapeBody => ({ role: ROLE.collectible, x: lane * RUNNER.laneWidth, y: 300, z, w: 500, h: 500, d: 500, kinematic: false });

/**
 * Dvě ručně postavené tratě běžce bez jediného společného vzoru (kalibrace „1“):
 * A = cik-cak, řetěz skoků, ulička skluzu; B = most, rozcestí, stezka věcí, volný úsek.
 */
export function handBuiltRunners(): { readonly a: readonly ShapeBody[]; readonly b: readonly ShapeBody[]; readonly length: number } {
  const gap = 12 * UNIT;
  const a: ShapeBody[] = [];
  let z = 25 * UNIT;
  [-1, 1, -1, 1, -1].forEach((open) => {
    for (const lane of [-1, 0, 1]) if (lane !== open) a.push(obstacle(lane, z, 'L'));
    z += gap;
  });
  for (let i = 0; i < 3; i += 1, z += gap) for (const lane of [-1, 0, 1]) a.push(obstacle(lane, z, 'J'));
  for (let i = 0; i < 3; i += 1, z += gap) for (const lane of [-1, 0, 1]) a.push(obstacle(lane, z, 'S'));

  const b: ShapeBody[] = [];
  b.push(obstacle(-1, 60 * UNIT, 'L', 40 * UNIT), obstacle(1, 60 * UNIT, 'L', 40 * UNIT));
  b.push(obstacle(0, 130 * UNIT, 'L', 30 * UNIT));
  for (let i = 0; i < 6; i += 1) b.push(coin([-1, 0, 1, 0, -1, 0][i] as number, 160 * UNIT + i * 3 * UNIT));
  for (const at of [190, 202, 214, 226, 290]) b.push(obstacle(0, at * UNIT, 'J'));
  return { a, b, length: Math.max(z, 300 * UNIT) };
}
