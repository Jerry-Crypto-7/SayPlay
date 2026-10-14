/**
 * Zem s kresbou (P46G T3). Zem, která „vypadá pestře“, může přesto ujet mimo
 * paletu sady nebo do fialové, a zem z náhody by se při každém načtení hry
 * přebarvila. Pinuje se: tatáž trať dá tytéž barvy, každý odstín je uvnitř
 * palety sady, nic fialového, a kresba tam opravdu je – odstíny, krajnice
 * u cesty a tmavnutí do strany.
 */

import { Color, type HSL, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, type Look } from '@/play/arcade/look';

import { type GroundPalette, boxEdge, buildFieldGround, buildRoadGround, groundPainter, groundPalette } from '../ground';
import type { StripSegment } from '../road-strip';

/** Silnice se šikanou a zúžením, jak ji kreslí závod. */
const ROAD: readonly StripSegment[] = [
  { near: -20, far: 40, center: 0, width: 10 },
  { near: 40, far: 70, center: 4, width: 10 },
  { near: 70, far: 140, center: 0, width: 7 },
];

/** Body na pásu 120 × 120 m po metru a kousek – kryje víc buněk šumu, ne jednu. */
const POINTS = Array.from({ length: 900 }, (_, i) => [((i % 30) - 15) * 4.1, Math.floor(i / 30) * 4.1 - 10] as const);
const EDGES = [null, -2, 0.3, 1, 3, 8, 20, 60] as const;

function isPurple(color: Color): boolean {
  const hsl: HSL = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl, SRGBColorSpace);
  return hsl.s > 0.05 && hsl.h * 360 >= 250 && hsl.h * 360 <= 320;
}

const colorsOf = (palette: GroundPalette): Color[] => Object.values(palette).map((hex) => new Color(hex));

/** Rozsah každého kanálu přes barvy palety (lineární). */
function hullOf(palette: GroundPalette): { readonly min: readonly number[]; readonly max: readonly number[] } {
  const channels = colorsOf(palette).map((color) => [color.r, color.g, color.b]);
  return { min: [0, 1, 2].map((k) => Math.min(...channels.map((c) => c[k]!))), max: [0, 1, 2].map((k) => Math.max(...channels.map((c) => c[k]!))) };
}

const luminance = (color: Color): number => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

function meanAt(look: Look, edge: number | null): Color {
  const paint = groundPainter(groundPalette(look));
  const sum = new Color(0, 0, 0);
  const color = new Color();
  for (const [x, z] of POINTS) sum.add(paint(x, z, edge, color));
  return sum.multiplyScalar(1 / POINTS.length);
}

describe('ground palette and painter', () => {
  it.each(LOOK_IDS)('%s keeps every ground shade inside its palette and none purple', (id) => {
    const look = LOOKS[id];
    // Údolí a závod malují zem sady, ostrůvky a aréna svou souš.
    const outside: string[] = [];
    const purple: string[] = [];
    for (const base of new Set([look.ground, look.land ?? look.ground])) {
      const palette = groundPalette(look, base);
      for (const color of colorsOf(palette)) if (isPurple(color)) purple.push(`palette #${color.getHexString()}`);
      const { min, max } = hullOf(palette);
      const paint = groundPainter(palette);
      const color = new Color();
      for (const edge of EDGES) {
        for (const [x, z] of POINTS) {
          paint(x, z, edge, color);
          const channels = [color.r, color.g, color.b];
          if (channels.some((value, k) => value < min[k]! - 1e-6 || value > max[k]! + 1e-6)) outside.push(`#${color.getHexString()} at ${x} ${z} edge ${edge}`);
          if (isPurple(color)) purple.push(`#${color.getHexString()} at ${x} ${z} edge ${edge}`);
        }
      }
    }
    expect(outside.slice(0, 5)).toEqual([]);
    expect(purple.slice(0, 5)).toEqual([]);
  });

  it('paints the same place the same colour every time', () => {
    const [a, b] = [groundPainter(groundPalette(LOOKS.forest)), groundPainter(groundPalette(LOOKS.forest))];
    const [first, second] = [new Color(), new Color()];
    const differ = EDGES.flatMap((edge) => POINTS.filter(([x, z]) => !a(x, z, edge, first).equals(b(x, z, edge, second))).map(([x, z]) => `${x} ${z} ${edge}`));
    expect(differ).toEqual([]);
  });

  it.each(['forest', 'desert', 'city', 'snow'] as const)('%s varies the ground in soft shades and patches, not one flat colour', (id) => {
    const paint = groundPainter(groundPalette(LOOKS[id]));
    const color = new Color();
    const shades = POINTS.map(([x, z]) => luminance(paint(x, z, null, color)));
    const base = luminance(new Color(LOOKS[id].ground));
    const spread = (Math.max(...shades) - Math.min(...shades)) / base;
    // Aspoň tři odstíny o víc než 3 % od sebe, ale bez skoku do jiné barvy.
    expect(spread).toBeGreaterThan(0.08);
    expect(new Set(shades.map((value) => Math.round(value / base / 0.03))).size).toBeGreaterThanOrEqual(3);
    // Sousední body (4 m) se liší jen málo: skvrny, ne konfety.
    const steps = POINTS.slice(1).map(([x, z], i) => (i % 30 === 29 ? 0 : Math.abs(luminance(paint(x, z, null, color)) - shades[i]!) / base));
    expect(steps.reduce((sum, step) => sum + step, 0) / steps.length).toBeLessThan(spread / 3);
  });

  it.each(['forest', 'city', 'desert'] as const)('%s lays a verge along the road edge and darkens away from it', (id) => {
    const verge = new Color(groundPalette(LOOKS[id]).verge);
    const [atEdge, inGrass, far] = [meanAt(LOOKS[id], 0.3), meanAt(LOOKS[id], 4), meanAt(LOOKS[id], 60)];
    const distance = (a: Color, b: Color): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
    expect(distance(atEdge, verge)).toBeLessThan(distance(inGrass, verge) / 3);
    expect(luminance(far)).toBeLessThan(luminance(inGrass) * 0.85);
  });
});

describe('race ground', () => {
  const ground = buildRoadGround(LOOKS.forest, ROAD, -60, 220);
  const position = ground.getAttribute('position');
  const color = ground.getAttribute('color');

  it('builds the same mesh and colours for the same road', () => {
    const again = buildRoadGround(LOOKS.forest, ROAD, -60, 220);
    expect(Array.from(again.getAttribute('position').array)).toEqual(Array.from(position.array));
    expect(Array.from(again.getAttribute('color').array)).toEqual(Array.from(color.array));
  });

  it('covers the road and 80 m to each side with a modest grid lying flat under it', () => {
    const xs = Array.from({ length: position.count }, (_, i) => position.getX(i));
    const zs = Array.from({ length: position.count }, (_, i) => position.getZ(i));
    expect(Math.min(...xs)).toBeLessThan(-80);
    expect(Math.max(...xs)).toBeGreaterThan(80);
    expect(Math.min(...zs)).toBe(-60);
    expect(Math.max(...zs)).toBe(220);
    expect(Array.from({ length: position.count }, (_, i) => position.getY(i)).every((y) => y === 0)).toBe(true);
    // Telefon: ~2 m řady a nanejvýš 31 sloupců, ne mřížka po metru přes 160 m.
    expect(position.count / ((220 + 60) / 2 + 1)).toBeLessThanOrEqual(31);
    const normal = ground.getAttribute('normal');
    for (let i = 0; i < normal.count; i += 37) expect(normal.getY(i)).toBeCloseTo(1, 6);
  });

  it('follows the road with its verge, also through the chicane', () => {
    const verge = new Color(groundPalette(LOOKS.forest).verge);
    const vertex = new Color();
    let near = 0;
    let checked = 0;
    for (let i = 0; i < position.count; i += 1) {
      const z = position.getZ(i);
      if (z < 50 || z > 60) continue;
      // Ve šikaně má cesta střed 4 m a šířku 10 m: kraj leží na x = 9 a x = −1.
      const edge = Math.min(Math.abs(position.getX(i) - 9), Math.abs(position.getX(i) + 1));
      if (edge > 0.05) continue;
      checked += 1;
      vertex.setRGB(color.getX(i), color.getY(i), color.getZ(i));
      if (Math.hypot(vertex.r - verge.r, vertex.g - verge.g, vertex.b - verge.b) < 0.02) near += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(near).toBe(checked);
  });
});

/**
 * Zem bez cesty (P46G T7): bludiště, hřiště, střelnice, ring. Rovina jedné barvy
 * by prošla každým testem scény; pinuje se, že síť leží rovně v celé ploše, má
 * kresbu a kolem hrací plochy krajnici, uvnitř ne.
 */
describe('field ground', () => {
  const FIELD = { x0: -10, x1: 14, z0: -2, z1: 30 } as const;
  const AREA = { x0: -60, x1: 64, z0: -40, z1: 80 } as const;
  const ground = buildFieldGround(LOOKS.forest, AREA, boxEdge(FIELD));
  const position = ground.getAttribute('position');
  const color = ground.getAttribute('color');
  const at = (i: number): Color => new Color(color.getX(i), color.getY(i), color.getZ(i));

  it('lies flat over the whole area with normals up, the same every time', () => {
    const xs = Array.from({ length: position.count }, (_, i) => position.getX(i));
    const zs = Array.from({ length: position.count }, (_, i) => position.getZ(i));
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([AREA.x0, AREA.x1, AREA.z0, AREA.z1]);
    expect(Array.from({ length: position.count }, (_, i) => position.getY(i)).every((y) => y === 0)).toBe(true);
    const normal = ground.getAttribute('normal');
    for (let i = 0; i < normal.count; i += 41) expect(normal.getY(i)).toBe(1);
    // Telefon: krok ~2,5 m, ne mřížka po metru.
    expect(position.count).toBeLessThan(((AREA.x1 - AREA.x0) / 2 + 1) * ((AREA.z1 - AREA.z0) / 2 + 1));
    expect(Array.from(buildFieldGround(LOOKS.forest, AREA, boxEdge(FIELD)).getAttribute('color').array)).toEqual(Array.from(color.array));
  });

  it('has shades instead of one colour, and a verge at the field edge but not inside', () => {
    const shades = new Set(Array.from({ length: color.count }, (_, i) => Math.round(luminance(at(i)) * 200)));
    expect(shades.size).toBeGreaterThan(8);
    const verge = new Color(groundPalette(LOOKS.forest).verge);
    const distance = (a: Color): number => Math.hypot(a.r - verge.r, a.g - verge.g, a.b - verge.b);
    const edge = boxEdge(FIELD);
    const mean = (test: (gap: number | null) => boolean): number => {
      const picked = Array.from({ length: position.count }, (_, i) => i).filter((i) => test(edge(position.getX(i), position.getZ(i))));
      return picked.reduce((sum, i) => sum + distance(at(i)), 0) / picked.length;
    };
    expect(mean((gap) => gap !== null && gap < 0.6)).toBeLessThan(mean((gap) => gap === null) / 3);
    expect(edge(0, 10)).toBeNull();
    expect(edge(-13, 10)).toBeCloseTo(3);
    expect(edge(17, 34)).toBeCloseTo(5);
  });
});
