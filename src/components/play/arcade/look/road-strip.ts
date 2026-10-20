/**
 * Cesta jako jeden souvislý pás (P46G T2). Silnice závodu byla poskládaná
 * z rovných obdélníků po úsecích, takže v zatáčce dělala schody a okrajové čáry
 * se trhaly. Tady se středy a šířky úseků proloží kubickou křivkou
 * (Catmull-Rom tečny omezené Fritsch–Carlsonem, aby rovný úsek zůstal rovný
 * a přechod nepřestřelil) a pás, okraje, značení i mantinely jdou po ní.
 *
 * Úsek drží svůj střed a šířku po celé délce kromě `EASE_M` u každého konce,
 * kde se přelije do sousedního – tam, kde jádro má schod mantinelů. Hranice
 * kolizí se nemění, mění se jen kresba. Čistá funkce úseků: stejná hra dá
 * stejnou geometrii.
 */

import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { Surface } from '@/play/arcade/look';

/** Úsek cesty ve scéně (m): od–do po trati, střed (x scény) a šířka mezi okraji. */
export interface StripSegment {
  readonly near: number;
  readonly far: number;
  readonly center: number;
  readonly width: number;
}

export interface StripSample {
  readonly z: number;
  readonly center: number;
  readonly width: number;
}

/** Na kolika metrech u konce úseku se cesta přelévá do sousedního. */
export const EASE_M = 6;
/** Krok vzorkování (m) a největší posun středu či šířky mezi sousedními vzorky. */
export const STEP_M = 0.5;
export const MAX_JUMP_M = 0.25;
/** Okrajová čára (asfalt) nebo lem pásu (ostatní povrchy): šířka a odsazení od okraje (m). */
const EDGE_LINE = { width: 0.12, inset: 0.15 } as const;
const EDGE_BAND = { width: 0.35, inset: 0 } as const;
/** Přerušovaná středová čára: šířka, kus a mezera (m). */
const DASH = { width: 0.14, on: 2, off: 2.5 } as const;
/** Spáry prken: šířka a rozteč (m). */
const SEAM = { width: 0.05, every: 0.7 } as const;
/** Výšky nad zemí: pás, okraje a značení nad ním, ať se nepřekrývají. */
const LIFT = { surface: 0.01, edge: 0.02, mark: 0.025 } as const;

interface Knot {
  readonly z: number;
  readonly center: number;
  readonly width: number;
}

/** Řídicí body: každý úsek drží hodnotu mezi `near + ease` a `far − ease`. */
function knotsOf(segments: readonly StripSegment[]): Knot[] {
  const knots: Knot[] = [];
  for (const segment of [...segments].sort((a, b) => a.near - b.near)) {
    const ease = Math.min(EASE_M, (segment.far - segment.near) / 2);
    for (const z of ease * 2 >= segment.far - segment.near ? [(segment.near + segment.far) / 2] : [segment.near + ease, segment.far - ease]) {
      if (knots.length === 0 || z > knots[knots.length - 1]!.z) knots.push({ z, center: segment.center, width: segment.width });
    }
  }
  return knots;
}

/** Monotónní kubická Hermitova křivka hodnot `ys` v bodech `zs`; mimo krajní body konstantní. */
function monotoneCubic(zs: readonly number[], ys: readonly number[]): (z: number) => number {
  const n = zs.length;
  const secant = Array.from({ length: n - 1 }, (_, i) => (ys[i + 1]! - ys[i]!) / (zs[i + 1]! - zs[i]!));
  // Catmull-Rom tečny (nerovnoměrné uzly), pak Fritsch–Carlson: plochý úsek zůstane plochý, žádný přestřel.
  const tangent = Array.from({ length: n }, (_, i) => {
    if (i === 0 || i === n - 1) return 0;
    const [left, right] = [secant[i - 1]!, secant[i]!];
    if (left * right <= 0) return 0;
    const catmull = (ys[i + 1]! - ys[i - 1]!) / (zs[i + 1]! - zs[i - 1]!);
    return Math.sign(catmull) * Math.min(Math.abs(catmull), 3 * Math.abs(left), 3 * Math.abs(right));
  });
  return (z) => {
    if (n === 1 || z <= zs[0]!) return ys[0]!;
    if (z >= zs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (z > zs[i + 1]!) i += 1;
    const h = zs[i + 1]! - zs[i]!;
    const t = (z - zs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * tangent[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * tangent[i + 1]!;
  };
}

/** Střed a šířka cesty v libovolném `z`. */
export function stripCurve(segments: readonly StripSegment[]): (z: number) => { readonly center: number; readonly width: number } {
  const knots = knotsOf(segments);
  const zs = knots.map((knot) => knot.z);
  const center = monotoneCubic(zs, knots.map((knot) => knot.center));
  const width = monotoneCubic(zs, knots.map((knot) => knot.width));
  return (z) => ({ center: center(z), width: width(z) });
}

/**
 * Vzorky křivky od začátku prvního úseku po konec posledního, aspoň po `STEP_M`;
 * kde by se střed nebo šířka mezi sousedy hnuly o víc než `MAX_JUMP_M`, krok se půlí.
 */
export function sampleStrip(segments: readonly StripSegment[]): StripSample[] {
  if (segments.length === 0) return [];
  const at = stripCurve(segments);
  const from = Math.min(...segments.map((segment) => segment.near));
  const to = Math.max(...segments.map((segment) => segment.far));
  const sample = (z: number): StripSample => ({ z, ...at(z) });
  const samples: StripSample[] = [sample(from)];
  const count = Math.ceil((to - from) / STEP_M);
  for (let i = 1; i <= count; i += 1) {
    const next = sample(i === count ? to : from + i * STEP_M);
    const refine = (a: StripSample, b: StripSample, depth: number): void => {
      if (depth < 6 && (Math.abs(b.center - a.center) > MAX_JUMP_M || Math.abs(b.width - a.width) > MAX_JUMP_M)) {
        const mid = sample((a.z + b.z) / 2);
        refine(a, mid, depth + 1);
        refine(mid, b, depth + 1);
      } else samples.push(b);
    };
    refine(samples[samples.length - 1]!, next, 0);
  }
  return samples;
}

type Point = readonly [x: number, y: number];

/**
 * Pás mezi dvěma body každého vzorku (`a` vlevo, `b` vpravo při pohledu po trati):
 * čtyřúhelníky mezi sousedními vzorky, natočené tak, aby pás od `a` k `b` hleděl nahoru.
 */
export function ribbon(samples: readonly StripSample[], edge: (sample: StripSample) => readonly [a: Point, b: Point]): BufferGeometry {
  const positions = new Float32Array(samples.length * 6);
  samples.forEach((sample, i) => {
    const [a, b] = edge(sample);
    positions.set([a[0], a[1], sample.z, b[0], b[1], sample.z], i * 6);
  });
  const index: number[] = [];
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const [a, b, a2, b2] = [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3];
    index.push(a, a2, b, b, a2, b2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** Index první hodnoty ≥ `value` ve vzestupném poli. */
export function firstAtLeast(values: Float64Array, value: number): number {
  let [lo, hi] = [0, values.length];
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Síť přes celou trať, kreslená jen kolem kamery (P54B T15d): trojúhelníky se seřadí podle
 * nejmenšího z, úsek trati je pak souvislý kus indexů a `drawRange` kreslí jen ten – v obraze
 * i ve stínu, pořád jedním voláním. Mantinely jízdy (18 540 trojúhelníků na 765 m) se jinak
 * kreslily celé dvakrát za snímek. Vrací posun okna `[from, to]` po z.
 */
export function windowAlongZ(geometry: BufferGeometry): (from: number, to: number) => void {
  const index = geometry.index!;
  const position = geometry.getAttribute('position');
  const count = index.count / 3;
  const low = new Float64Array(count);
  // Nejdelší trojúhelník po z: okno začíná o tolik dřív, ať ho neusekne (kvádry ostrůvků).
  let longest = 0;
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = [0, 1, 2].map((j) => position.getZ(index.getX(t * 3 + j)));
    low[t] = Math.min(a!, b!, c!);
    longest = Math.max(longest, Math.max(a!, b!, c!) - low[t]!);
  }
  const order = Uint32Array.from({ length: count }, (_, t) => t).sort((p, q) => low[p]! - low[q]!);
  const sorted = new Uint32Array(index.count);
  const starts = new Float64Array(count);
  order.forEach((t, k) => {
    for (let j = 0; j < 3; j += 1) sorted[k * 3 + j] = index.getX(t * 3 + j);
    starts[k] = low[t]!;
  });
  geometry.setIndex(new BufferAttribute(sorted, 1));
  return (from, to) => {
    const first = firstAtLeast(starts, from - longest);
    geometry.setDrawRange(first * 3, (firstAtLeast(starts, to) - first) * 3);
  };
}

/** Vzorky v `[from, to]`; krajní body dopočítané z křivky, ať kus nekončí o krok vedle. */
function slice(samples: readonly StripSample[], from: number, to: number, at: (z: number) => { readonly center: number; readonly width: number }): StripSample[] {
  return [{ z: from, ...at(from) }, ...samples.filter((sample) => sample.z > from && sample.z < to), { z: to, ...at(to) }];
}

export interface RoadGeometry {
  readonly surface: BufferGeometry;
  /** Okrajové čáry (asfalt) nebo lemy pásu. */
  readonly edges: BufferGeometry;
  /** Středová čára nebo spáry prken; `null` = povrch bez značení. */
  readonly marks: BufferGeometry | null;
  /** Mantinely po obou okrajích; `null` = bez nich. */
  readonly walls: BufferGeometry | null;
}

/**
 * Pás cesty s okraji, značením a mantinely z úseků. `walls` = výška a tloušťka
 * mantinelu (stojí vně cesty) nebo `null`.
 */
export function roadGeometry(segments: readonly StripSegment[], surface: Surface, walls: { readonly height: number; readonly thickness: number } | null = null): RoadGeometry | null {
  const samples = sampleStrip(segments);
  if (samples.length < 2) return null;
  const at = stripCurve(segments);
  const side = (sample: StripSample, offset: number): number => sample.center + offset * sample.width / 2;
  const road = ribbon(samples, (s) => [[side(s, -1), LIFT.surface], [side(s, 1), LIFT.surface]]);
  const line = surface.marks?.kind === 'dashes' ? EDGE_LINE : EDGE_BAND;
  const edges = mergeGeometries(
    [-1, 1].map((sign) =>
      ribbon(samples, (s) => {
        const outer = s.center + sign * (s.width / 2 - line.inset);
        const inner = outer - sign * line.width;
        return sign < 0 ? [[outer, LIFT.edge], [inner, LIFT.edge]] : [[inner, LIFT.edge], [outer, LIFT.edge]];
      }),
    ),
  );
  const from = samples[0]!.z;
  const to = samples[samples.length - 1]!.z;
  let marks: BufferGeometry | null = null;
  if (surface.marks?.kind === 'dashes') {
    const pieces: BufferGeometry[] = [];
    for (let z = from + DASH.off / 2; z + DASH.on <= to; z += DASH.on + DASH.off) {
      pieces.push(ribbon(slice(samples, z, z + DASH.on, at), (s) => [[s.center - DASH.width / 2, LIFT.mark], [s.center + DASH.width / 2, LIFT.mark]]));
    }
    marks = pieces.length === 0 ? null : mergeGeometries(pieces);
  } else if (surface.marks?.kind === 'seams') {
    const pieces: BufferGeometry[] = [];
    for (let z = from + SEAM.every; z + SEAM.width <= to; z += SEAM.every) {
      pieces.push(ribbon(slice(samples, z, z + SEAM.width, at), (s) => [[side(s, -1), LIFT.mark], [side(s, 1), LIFT.mark]]));
    }
    marks = pieces.length === 0 ? null : mergeGeometries(pieces);
  }
  let wallGeometry: BufferGeometry | null = null;
  if (walls !== null) {
    const { height: h, thickness: t } = walls;
    // Každý mantinel: vnitřní stěna k cestě, vršek a vnější stěna, každá plocha zvlášť (ostré hrany).
    const faces = [-1, 1].flatMap((sign) => {
      const inner = (s: StripSample): number => side(s, sign);
      const outer = (s: StripSample): number => side(s, sign) + sign * t;
      return sign < 0
        ? [
            ribbon(samples, (s) => [[inner(s), h], [inner(s), 0]]),
            ribbon(samples, (s) => [[outer(s), h], [inner(s), h]]),
            ribbon(samples, (s) => [[outer(s), 0], [outer(s), h]]),
          ]
        : [
            ribbon(samples, (s) => [[inner(s), 0], [inner(s), h]]),
            ribbon(samples, (s) => [[inner(s), h], [outer(s), h]]),
            ribbon(samples, (s) => [[outer(s), h], [outer(s), 0]]),
          ];
    });
    wallGeometry = mergeGeometries(faces);
  }
  return { surface: road, edges, marks, walls: wallGeometry };
}
