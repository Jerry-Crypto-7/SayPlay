/**
 * Ostrůvky (P32A T9, ukázka B): skalní sloupy z vody s rovnou horní plochou
 * a okrajem podle sady – travnatým, v zasněžené sadě sněhovým, v písečné
 * písečným. Plošinovka (P32F T5) z nich staví pevné desky jádra
 * (`platformIslands`), plavba (P32F T4) kulaté ostrovy v moři (`round`).
 *
 * Horní plocha je rovný mnohoúhelník přesně ve výšce desky. Kryje celou desku
 * a podél trati končí přesně na její hraně – hrana skoku je vidět tam, kde je.
 * Za ní se okraj láme dolů (lem), pod lemem je pás hlíny, ledu nebo písku
 * a skála: pod deskou se ke dnu zužuje (mezera zůstane mezerou), kulatý ostrov
 * se k vodě rozšiřuje. Pata (`base`, u ostrovů ve vodě hladina) je čára břehu,
 * skála pod ní jde ještě kus pod vodu, ať ji vlna neodhalí.
 *
 * Bez indexů, normála na plochu (flat shading), barvy ve vrcholech z palety
 * sady. `heightAt` vrací výšku, kterou síť shora opravdu kreslí. Čistá funkce
 * vstupu: žádná náhoda, tatáž úroveň má pokaždé stejné ostrůvky.
 */

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

import { type ArcadeWorld, BODY, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { PLATFORM } from '@/play/arcade/pieces/platform';

import { groundPainter, groundPalette } from '../../ground';
import { hash, mix } from './valley';

export type Vertex = readonly [x: number, y: number, z: number];
type Point = readonly [x: number, z: number];

/**
 * Trojúhelníky s barvou na plochu; normály až v `geometry()` (bez indexů = flat
 * shading i pod `MeshToonMaterial`). Sdílí ho podlaha arény.
 */
export class Faces {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  /** Kam se sbírají trojúhelníky s normálou nahoru (`heightAt`); `null` = nesbírat. */
  collect: number[] | null = null;

  tri(a: Vertex, b: Vertex, c: Vertex, color: Color): void {
    this.positions.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k += 1) this.colors.push(color.r, color.g, color.b);
    if (this.collect !== null && upOf(a, b, c) > 1e-6) this.collect.push(...a, ...b, ...c);
  }

  /** Trojúhelník s barvou v každém vrcholu (`paint` z polohy vrcholu): sousední plochy na sebe barvou plynule navazují. */
  triPainted(a: Vertex, b: Vertex, c: Vertex, paint: (vertex: Vertex) => Color): void {
    this.positions.push(...a, ...b, ...c);
    for (const vertex of [a, b, c]) {
      const color = paint(vertex);
      this.colors.push(color.r, color.g, color.b);
    }
    if (this.collect !== null && upOf(a, b, c) > 1e-6) this.collect.push(...a, ...b, ...c);
  }

  /**
   * Pás mezi horním a spodním prstencem se stejným počtem bodů, oba v pořadí
   * s kladnou plochou (`ccw`): normála míří ven. Úhlopříčka se střídá podle
   * hashe, `paint` dostane index, y normály a střed trojúhelníku (y, x, z).
   */
  band(upper: readonly Vertex[], lower: readonly Vertex[], seed: number, paint: (i: number, up: number, y: number, x: number, z: number) => Color): void {
    const n = upper.length;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const [ui, uj, li, lj] = [upper[i]!, upper[j]!, lower[i]!, lower[j]!];
      const pair: readonly (readonly [Vertex, Vertex, Vertex])[] = hash(seed, i) < 0.5 ? [[ui, uj, li], [uj, lj, li]] : [[ui, uj, lj], [ui, lj, li]];
      for (const [a, b, c] of pair) this.tri(a, b, c, paint(i, upOf(a, b, c), (a[1] + b[1] + c[1]) / 3, (a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3));
    }
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }
}

/** Y jednotkové normály trojúhelníku (pořadí vrcholů jako v `Faces`). */
function upOf(a: Vertex, b: Vertex, c: Vertex): number {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  return ny / Math.max(1e-12, Math.hypot(nx, ny, nz));
}

/** Obrys v pořadí s kladnou plochou (x vpravo, z nahoru proti směru hodinek) – v něm `Faces.band` míří ven. */
export function ccw<T extends Point>(points: T[]): T[] {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [p, q] = [points[i]!, points[(i + 1) % points.length]!];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area < 0 ? points.reverse() : points;
}

/** Vějíř ze středu `center` přes prstenec `ring` (kladná plocha) s normálou nahoru. */
export function capOf(faces: Faces, center: Vertex, ring: readonly Vertex[], paint: (i: number) => Color): void {
  for (let i = 0; i < ring.length; i += 1) faces.tri(center, ring[(i + 1) % ring.length]!, ring[i]!, paint(i));
}

export interface IslandSpot {
  /** Střed ve scéně (m). */
  readonly x: number;
  readonly z: number;
  /** Šířka napříč tratí (osa x) a délka podél ní (osa z), m. */
  readonly w: number;
  readonly d: number;
  /** Výška horní plochy (m). */
  readonly top: number;
  /** Kulatý ostrov v moři. Bez toho deska: horní plocha kryje obdélník `w × d` a podél z končí přesně na jeho hraně. */
  readonly round?: boolean;
}

/** Klíč polohy těla v jednotkách jádra – tak, jak ji `World` zapíše skupině (scéna, x zrcadlené). */
export const spotKey = (x: number, y: number, z: number): string => `${Math.round(x * UNIT)},${Math.round(y * UNIT)},${Math.round(z * UNIT)}`;

/**
 * Klíče poloh pevných desek plošinovky (`spotKey`, spodní stěna desky): jejich kvádry
 * `World` kreslí a `PlatformWorld` je schová pod ostrůvky. Pohyblivá plošina mezi nimi není.
 */
export function platformSlabKeys(world: ArcadeWorld): Set<string> {
  return new Set(platformIslands(world).map((spot) => spotKey(spot.x, spot.top - PLATFORM.slabH / UNIT, spot.z)));
}

/** Ostrůvky pod pevnými deskami úrovně (tělo `platform`). Pohyblivá plošina si vzhled nechává – hráč z něj čte pohyb. */
export function platformIslands(world: ArcadeWorld): IslandSpot[] {
  const state = world.initial;
  const spots: IslandSpot[] = [];
  for (let index = 0; index < (state[HEADER.bodyCount] as number); index += 1) {
    const base = bodyBase(index);
    if (state[base + BODY.role] !== ROLE.platform || world.kinds[state[base + BODY.kind] as number] !== 'platform') continue;
    const at = (slot: number): number => (state[base + slot] as number) / UNIT;
    // Scéna zrcadlí x jádra (`World.tsx`), `y` je spodní stěna desky.
    spots.push({ x: -at(BODY.x), z: at(BODY.z), w: at(BODY.w), d: at(BODY.d), top: at(BODY.y) + at(BODY.h) });
  }
  return spots;
}

export interface IslandPalette {
  /** Horní plocha, lem, pás pod lemem, skála a mokrá skála u vody. */
  readonly top: string;
  readonly rim: string;
  readonly band: string;
  readonly rock: string;
  readonly wet: string;
}

/**
 * Barvy ostrůvků: souš sady (`land`, jinak `ground`), okraj podle `cover`. Skála ze
 * skály údolí nebo bloků sady, zesvětlená – boky sloupu jsou svislé a slunce na ně
 * svítí z boku, v barvě svahu údolí by na snímku splynuly v černou.
 */
export function islandPalette(look: Look): IslandPalette {
  const land = look.land ?? look.ground;
  // Sady bez vlastní skály (les, džungle) mají hlínu, ne šedý kámen – šedé sloupy pod zelenou
  // plochou na snímku P46G T9 nečetly jako les.
  const rock = mix(look.terrain?.rock ?? look.block?.[0] ?? mix(land, '#7a5236', 0.8), '#d6d3d1', 0.2);
  const wet = mix(rock, '#1c1917', 0.35);
  // Sníh: čepička, pod ní pás ledu.
  if (look.cover === 'snow') return { top: look.terrain?.cap ?? land, rim: land, band: look.terrain?.lane ?? mix(land, look.water, 0.4), rock, wet };
  if (look.cover === 'sand') return { top: land, rim: mix(land, '#ffffff', 0.18), band: mix(land, rock, 0.4), rock, wet };
  // Tráva a ostatní: tmavší travnatý lem, pod ním hlína.
  return { top: land, rim: mix(land, '#000000', 0.18), band: mix(rock, '#7c4a2a', 0.6), rock, wet };
}

/** Jak daleko lem přečnívá horní plochu, jak klesá, a kde končí pás pod ním (m). */
const LIP = 0.16;
const DROP = 0.13;
const BAND = 0.45;
/** Pás pod lemem je o kousek uvnitř lemu: shora ho lem kryje. */
const BAND_IN = 0.08;
/** O kolik smí bok desky vystoupit napříč tratí (m) a krok bodů po její délce. */
const SIDE_OUT = 0.28;
const STEP = 1;
/** Skála pod patou (m): vlna ji neodhalí. */
const FOOT = 1.2;

/** Obrys desky: konce přesně na hraně desky, boky napříč tratí zubaté a jen ven. */
function slabOutline(spot: IslandSpot, seed: number): Point[] {
  const [x0, x1, z0, z1] = [spot.x - spot.w / 2, spot.x + spot.w / 2, spot.z - spot.d / 2, spot.z + spot.d / 2];
  const out = (k: number): number => 0.04 + SIDE_OUT * hash(seed, k);
  const n = Math.max(1, Math.round(spot.d / STEP));
  const along = (k: number, salt: number): number => z0 + (k + (hash(seed, salt + k) - 0.5) * 0.5) * (spot.d / n);
  const mid = (salt: number): number => spot.x + (hash(seed, salt) - 0.5) * 0.3 * spot.w;
  const points: Point[] = [[x0 - out(0), z0], [mid(1), z0], [x1 + out(2), z0]];
  for (let k = 1; k < n; k += 1) points.push([x1 + out(10 + k), along(k, 100)]);
  points.push([x1 + out(3), z1], [mid(4), z1], [x0 - out(5), z1]);
  for (let k = n - 1; k >= 1; k -= 1) points.push([x0 - out(200 + k), along(k, 300)]);
  return points;
}

/** Obrys ostrova: elipsa `w × d` se zvlněným poloměrem. */
function roundOutline(spot: IslandSpot, seed: number): Point[] {
  const n = Math.min(28, Math.max(10, Math.round((Math.PI * (spot.w + spot.d)) / 2 / 1.1)));
  return Array.from({ length: n }, (_, k): Point => {
    const angle = ((k + (hash(seed, k) - 0.5) * 0.5) / n) * 2 * Math.PI;
    const r = 0.86 + 0.2 * hash(seed, 50 + k);
    return [spot.x + (spot.w / 2) * r * Math.cos(angle), spot.z + (spot.d / 2) * r * Math.sin(angle)];
  });
}

/** Směr posunu vrcholu ven: osa úhlu, prodloužená tak, aby posun o `s` dal rovnoběžku ve vzdálenosti `s`. */
function outwardOf(points: readonly Point[]): Point[] {
  const n = points.length;
  const edges = points.map((p, i): Point => {
    const q = points[(i + 1) % n]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[1] - p[1]) / len, -(q[0] - p[0]) / len];
  });
  return points.map((_, i): Point => {
    const [a, b] = [edges[(i + n - 1) % n]!, edges[i]!];
    const [nx, nz] = [a[0] + b[0], a[1] + b[1]];
    const len = Math.hypot(nx, nz) || 1;
    const cos = Math.max(0.6, (nx * b[0] + nz * b[1]) / len);
    return [nx / len / cos, nz / len / cos];
  });
}

/** Výška trojúhelníku `tris[o..o+9]` v bodě (x, z), `null` = bod je mimo něj. */
function heightIn(t: readonly number[], o: number, x: number, z: number): number | null {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = [t[o]!, t[o + 1]!, t[o + 2]!, t[o + 3]!, t[o + 4]!, t[o + 5]!, t[o + 6]!, t[o + 7]!, t[o + 8]!];
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(det) < 1e-12) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

/** Vzdálenost bodu od obrysu (m), uvnitř záporná. */
function signedDistance(polygon: readonly Point[], x: number, z: number): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [p, q] = [polygon[i]!, polygon[j]!];
    if (p[1] > z !== q[1] > z && x < ((q[0] - p[0]) * (z - p[1])) / (q[1] - p[1]) + p[0]) inside = !inside;
    const [ex, ez] = [q[0] - p[0], q[1] - p[1]];
    const t = Math.min(1, Math.max(0, ((x - p[0]) * ex + (z - p[1]) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(x - p[0] - t * ex, z - p[1] - t * ez));
  }
  return inside ? -best : best;
}

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const boxOf = (points: readonly (readonly number[])[], ix: number, iz: number): Box => ({
  minX: Math.min(...points.map((p) => p[ix]!)),
  maxX: Math.max(...points.map((p) => p[ix]!)),
  minZ: Math.min(...points.map((p) => p[iz]!)),
  maxZ: Math.max(...points.map((p) => p[iz]!)),
});

export interface Islands {
  readonly geometry: BufferGeometry;
  /** Výška, kterou síť shora kreslí (m); `null` = žádný ostrůvek (voda, mezera mezi deskami). */
  heightAt(x: number, z: number): number | null;
  /**
   * Vzdálenost od čáry břehu v patě (m), na souši záporná – pěna vody (`water.ts`).
   * Nejvýš `within`: ostrov s obálkou dál se nepočítá (P35 T4).
   */
  shoreDistance(x: number, z: number, within?: number): number;
}

export interface IslandsOptions {
  readonly look: Look;
  readonly islands: readonly IslandSpot[];
  /** Výška paty (m): u ostrůvků ve vodě hladina, tam je čára břehu. */
  readonly base: number;
  /** Bez skály pod pásem: pod deskou stojí dům (`city-blocks.ts`), ostrůvek je jen střecha. */
  readonly roofOnly?: boolean;
}

export function buildIslands({ look, islands, base, roofOnly = false }: IslandsOptions): Islands {
  const palette = islandPalette(look);
  const colors = { rim: new Color(palette.rim), band: new Color(palette.band), rock: new Color(palette.rock), wet: new Color(palette.wet) };
  const ground = groundPainter(groundPalette(look, palette.top));
  const face = new Color();
  const tint = (color: Color, scale: number): Color => face.copy(color).multiplyScalar(scale);
  const faces = new Faces();
  const parts: { readonly tris: number[]; readonly box: Box; readonly shore: readonly Point[]; readonly shoreBox: Box }[] = [];

  islands.forEach((spot, index) => {
    const seed = index * 131 + 17;
    const h = (ring: number, i: number): number => hash(seed + ring * 7919, i);
    const outline = ccw(spot.round === true ? roundOutline(spot, seed) : slabOutline(spot, seed));
    const outward = outwardOf(outline);
    const ring = (offset: (i: number) => number, height: (i: number) => number): Vertex[] =>
      outline.map((p, i) => [p[0] + outward[i]![0] * offset(i), height(i), p[1] + outward[i]![1] * offset(i)]);

    const top = ring(() => 0, () => spot.top);
    const lip = ring((i) => LIP * (0.75 + 0.5 * h(1, i)), (i) => spot.top - DROP * (0.7 + 0.6 * h(2, i)));
    const band = ring(() => BAND_IN, (i) => Math.max(base + 0.3 * (spot.top - base), spot.top - BAND * (0.8 + 0.4 * h(3, i))));
    // Skála: deska se ke dnu zužuje (a nikde nevyčnívá zpod lemu), kulatý ostrov se k vodě rozšiřuje.
    const flare = spot.round === true ? 0.22 * Math.min(spot.w, spot.d) : -Math.min(0.5, 0.15 * Math.min(spot.w, spot.d));
    const levels = roofOnly ? 0 : Math.max(1, Math.round((spot.top - BAND - base) / 1.7));
    const rock: Vertex[][] = [band];
    for (let k = 1; k <= levels; k += 1) {
      const f = k / levels;
      rock.push(
        ring(
          (i) => {
            const s = BAND_IN + flare * f * (0.7 + 0.6 * h(10 + k, i)) + (h(20 + k, i) - 0.5) * 0.18;
            return spot.round === true ? s : Math.min(s, BAND_IN);
          },
          (i) => {
            const from = band[i]![1];
            return k === levels ? base : from + (base - from) * f + (h(30 + k, i) - 0.5) * 0.3 * ((from - base) / levels);
          },
        ),
      );
    }
    const shore = rock[rock.length - 1]!;
    const cx = outline.reduce((sum, p) => sum + p[0], 0) / outline.length;
    const cz = outline.reduce((sum, p) => sum + p[1], 0) / outline.length;

    const tris: number[] = [];
    faces.collect = tris;
    // Horní plocha: vějíř ze středu a dva pásy ven, všechny vrcholy přesně ve výšce desky. Tráva (sníh, písek)
    // má odstíny a skvrny země sady (P46G T3), kresba v měřítku 2,5×, ať se vejde i na ostrůvek o pár metrech.
    const inset = (f: number): Vertex[] => top.map((v): Vertex => [cx + (v[0] - cx) * f, spot.top, cz + (v[2] - cz) * f]);
    const [core, middle] = [inset(1 / 3), inset(2 / 3)];
    const grass = (x: number, z: number, i: number): Color => ground(x * 2.5, z * 2.5, null, face).multiplyScalar(0.97 + 0.05 * h(40, i));
    capOf(faces, [cx, spot.top, cz], core, (i) => grass((cx + core[i]![0] + core[(i + 1) % core.length]![0]) / 3, (cz + core[i]![2] + core[(i + 1) % core.length]![2]) / 3, i));
    faces.band(core, middle, seed + 5, (i, _up, _y, x, z) => grass(x, z, i));
    faces.band(middle, top, seed + 6, (i, _up, _y, x, z) => grass(x, z, i));
    faces.band(top, lip, seed + 1, (i) => tint(colors.rim, 0.92 + 0.1 * h(41, i)));
    // Pod lemem pás; tu a tam z lemu přetéká tráva, sníh nebo písek.
    faces.band(lip, band, seed + 2, (i) => (h(42, i) < 0.25 ? tint(colors.rim, 0.9) : tint(colors.band, 0.9 + 0.15 * h(43, i))));
    for (let k = 0; k + 1 < rock.length; k += 1) {
      faces.band(rock[k]!, rock[k + 1]!, seed + 3 + k, (i, up, y) => {
        // Plochy skloněné k nebi kryje povrch sady, u vody je skála mokrá.
        if (up > 0.55) return tint(colors.rim, 0.95);
        if (y < base + 0.35) return tint(colors.wet, 0.95 + 0.1 * h(44 + k, i));
        return tint(colors.rock, 0.82 + 0.25 * h(50 + k, i));
      });
    }
    // Dno: u skály kužel pod hladinu, u střechy rovný podhled.
    const bottom = roofOnly ? Math.min(...shore.map((v) => v[1])) : base - FOOT;
    for (let i = 0; i < shore.length; i += 1) faces.tri([cx, bottom, cz], shore[i]!, shore[(i + 1) % shore.length]!, colors.wet);
    faces.collect = null;
    const waterline = shore.map((v): Point => [v[0], v[2]]);
    const corners: number[][] = [];
    for (let o = 0; o < tris.length; o += 3) corners.push([tris[o]!, tris[o + 2]!]);
    parts.push({ tris, box: boxOf(corners, 0, 1), shore: waterline, shoreBox: boxOf(waterline, 0, 1) });
  });

  const heightAt = (x: number, z: number): number | null => {
    let best: number | null = null;
    for (const { tris, box } of parts) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      for (let o = 0; o < tris.length; o += 9) {
        const y = heightIn(tris, o, x, z);
        if (y !== null && (best === null || y > best)) best = y;
      }
    }
    return best;
  };

  const shoreDistance = (x: number, z: number, within = Infinity): number => {
    let best = within;
    for (const { shore, shoreBox: box } of parts) {
      // Obálka dál než dosud nejbližší břeh: ostrov bližší být nemůže (ostrovy se nepřekrývají).
      if (Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minZ - z, 0, z - box.maxZ)) >= best) continue;
      best = Math.min(best, signedDistance(shore, x, z));
    }
    return best;
  };

  return { geometry: faces.geometry(), heightAt, shoreDistance };
}
