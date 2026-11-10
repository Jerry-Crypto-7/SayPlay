/**
 * Zem s kresbou (P46G T3). Plocha kolem trati byla jedna barva sady a hrála
 * jako koberec. Tady má dva až tři odstíny ze šumu, skvrny podle povrchu sady
 * (mech v trávě, světlejší písek, led ve sněhu, šmouhy na dlažbě, tmavší
 * skála), podél cesty pás krajnice (štěrk u silnice a dlažby, vyšlapaný kraj
 * u hliněné, písečné a sněžné cesty) a do strany od trati tmavne.
 *
 * Barvy jsou lineární (`new Color(hex)` jako zbytek terénu). Každý odstín je
 * směs barev palety (`groundPalette`), takže z ní nevyjde. Šum je hash
 * souřadnic – žádná náhoda, tatáž trať má pokaždé stejnou zem. Jen vzhled:
 * jádro o zemi neví, hash hry se nehne.
 */

import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute } from 'three';

import { type Cover, type Look, SURFACES } from '@/play/arcade/look';

import { type StripSegment, stripCurve } from './road-strip';

/** Celočíselný hash dvou souřadnic do [0, 1). Sdílí ho všechny generátory terénu. */
export function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Hladký šum hodnot v [0, 1). */
export function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

export const mix = (from: string, to: string, t: number): string => `#${new Color(from).lerp(new Color(to), t).getHexString()}`;

export interface GroundPalette {
  /** Tři odstíny země: ve stínu, základní (zem sady) a prosvětlený. */
  readonly dark: string;
  readonly base: string;
  readonly light: string;
  /** Skvrny podle povrchu sady. */
  readonly patch: string;
  /** Pás krajnice podél cesty. */
  readonly verge: string;
  /** Kam zem do strany od trati tmavne. */
  readonly far: string;
}

/** Skvrny podle povrchu: mech v trávě, světlejší písek, led ve sněhu, šmouhy na dlažbě, tmavší skála. */
const PATCH: Readonly<Record<Cover, (base: string, look: Look) => string>> = {
  grass: (base) => mix(base, '#4d7c0f', 0.5),
  sand: (base) => mix(base, '#f3e1b5', 0.45),
  snow: (base, look) => mix(base, look.terrain?.lane ?? '#a7cde4', 0.35),
  paving: (base) => mix(base, '#3f3a36', 0.3),
  rock: (base) => mix(base, '#1c1917', 0.35),
};

/** Tráva bez neonu (P81 R2): sytost země v trávě krát tolik – předloha má měkkou zelenou, ne svítivou. */
export const GRASS_SATURATION = 0.75;
const hsl = { h: 0, s: 0, l: 0 };
const soften = (hex: string, amount: number): string => {
  const color = new Color(hex);
  color.getHSL(hsl);
  return `#${color.setHSL(hsl.h, hsl.s * amount, hsl.l).getHexString()}`;
};

/**
 * Paleta země sady. `land` = barva souše (údolí a závod `ground`, ostrůvky a aréna
 * svou souš). Stín a dálka jdou k barvě polokoule zespodu, světlo ke slunci sady.
 */
export function groundPalette(look: Look, land: string = look.ground): GroundPalette {
  const road = SURFACES[look.surface];
  const base = look.cover === 'grass' ? soften(land, GRASS_SATURATION) : land;
  return {
    dark: mix(mix(base, look.light[1], 0.3), '#000000', 0.1),
    base,
    light: mix(base, look.sunColor, 0.12),
    patch: PATCH[look.cover](base, look),
    // Zem vyšlapaná do barvy cesty a tmavší – kraj cesty a arény jako obrys (P81 T4), ne krémový štěrk.
    verge: mix(mix(base, road.color, 0.35), '#1c1917', 0.3),
    far: mix(mix(base, look.light[1], 0.5), '#000000', 0.3),
  };
}

/** Kde a jak rychle zem do strany od trati tmavne (m od kraje cesty). */
const FAR_FROM_M = 6;
const FAR_SPAN_M = 30;

/**
 * Barva země v bodě scény (x, z) do `target`. `edge` = vzdálenost od kraje
 * cesty nebo hrací plochy (m, na cestě záporná); `null` = bez cesty (ostrůvky),
 * pak jen odstíny a skvrny.
 */
export type GroundPaint = (x: number, z: number, edge: number | null, target: Color) => Color;

/** `vergeM` = průměrná šířka krajnice od kraje cesty (m). */
export function groundPainter(palette: GroundPalette, vergeM = 1.4): GroundPaint {
  const [dark, base, light, patch, verge, far] = [palette.dark, palette.base, palette.light, palette.patch, palette.verge, palette.far].map((hex) => new Color(hex)) as [Color, Color, Color, Color, Color, Color];
  return (x, z, edge, target) => {
    // Odstín: tři oktávy šumu, roztažené kolem středu – průměr šumu hodnot krajů skoro nedosáhne.
    const n = 0.5 * noise(x * 0.06 + 31, z * 0.06 - 17) + 0.3 * noise(x * 0.17 - 5, z * 0.17 + 11) + 0.2 * noise(x * 0.45 + 3, z * 0.45 - 29);
    const t = Math.min(1, Math.max(0, (n - 0.5) * 2.6 + 0.5));
    if (t < 0.5) target.copy(dark).lerp(base, t * 2);
    else target.copy(base).lerp(light, t * 2 - 1);
    // Skvrny s měkkým, roztřepeným krajem tam, kde hrubý šum přeleze práh.
    const p = 0.7 * noise(x * 0.1 + 101, z * 0.1 + 7) + 0.3 * noise(x * 0.38 - 61, z * 0.38 + 43);
    target.lerp(patch, 0.85 * smooth((p - 0.58) / 0.1));
    if (edge === null) return target;
    // Krajnice: pás od kraje cesty, jeho hranice se podél trati vlní.
    const border = vergeM * (0.7 + 0.6 * noise(x * 0.2 + 5, z * 0.35 - 3));
    target.lerp(verge, 1 - smooth((edge - border) / 0.6 + 0.5));
    return target.lerp(far, 0.65 * smooth((edge - FAR_FROM_M) / FAR_SPAN_M));
  };
}

/** Obdélník ve scéně (m): x od `x0` do `x1`, z od `z0` do `z1`; nekonečná mez = pás bez konce. */
export interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

/** Kraj hrací plochy pro `groundPainter`: vzdálenost od obdélníku (m) venku, `null` uvnitř – plocha má odstíny a skvrny, ne krajnici. */
export function boxEdge({ x0, x1, z0, z1 }: Box): (x: number, z: number) => number | null {
  return (x, z) => {
    const [dx, dz] = [Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)];
    return dx === 0 && dz === 0 ? null : Math.hypot(dx, dz);
  };
}

/** Krok mřížky rovné země (m): nejjemnější oktáva šumu má ~2 m, hustší síť by ji jen přepočítala. */
const FIELD_CELL_M = 2.5;
/** Interiér: nejtmavší odstín vrcholu (podíl bílé), ztmavení u stěny a jak daleko od ní sahá (m). */
export const INTERIOR_TONE = 0.9;
export const WALL_AO = 0.22;
const WALL_AO_M = 1.5;

/**
 * Rovná zem pod hrou bez cesty (P46G T7: bludiště, hřiště, střelnice, ring…):
 * mřížka v y = 0 přes `area` s barvami ve vrcholech z `groundPainter`, normála
 * nahoru. `edge` = kraj hrací plochy (`boxEdge`); bez něj jen odstíny a skvrny.
 *
 * Interiér (P62 T6, `Look.interior`) má bílé vrcholy a UV v metrech: dlažbu dá
 * textura povrchu (`interiorFloorMap`), ne zem sady – ta se skvrnami a krajnicí
 * četla jako venek. Hradní nádvoří (`stone`) má dlažbu taky (P81 R6: kde byly dlaždice, zůstanou).
 */
export function buildFieldGround(look: Look, area: Box, edge: (x: number, z: number) => number | null = () => null): BufferGeometry {
  const paint = look.interior === undefined ? groundPainter(groundPalette(look)) : null;
  const columns = Math.max(1, Math.ceil((area.x1 - area.x0) / FIELD_CELL_M));
  const rows = Math.max(1, Math.ceil((area.z1 - area.z0) / FIELD_CELL_M));
  const count = (rows + 1) * (columns + 1);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(positions.length);
  const normals = new Float32Array(positions.length);
  const uvs = paint === null ? new Float32Array(count * 2) : null;
  const color = new Color(1, 1, 1);
  // Zápis po složkách, ne `set([…])`: pole na vrchol stálo na telefonu při montáži scény kola desítky ms (T13a).
  let at = 0;
  for (let row = 0; row <= rows; row += 1) {
    const z = area.z0 + ((area.z1 - area.z0) * row) / rows;
    for (let column = 0; column <= columns; column += 1) {
      const x = area.x0 + ((area.x1 - area.x0) * column) / columns;
      if (paint !== null) paint(x, z, edge(x, z), color);
      else {
        // Interiér (P73D T3): textura nese dlažbu, vrcholy variaci odstínu a jemné AO u stěn – dlažba nečte jako vzorník.
        const wall = Math.min(x - area.x0, area.x1 - x, z - area.z0, area.z1 - z);
        color.setScalar((INTERIOR_TONE + (1 - INTERIOR_TONE) * noise(x * 0.15 + 13, z * 0.15 - 7)) * (1 - WALL_AO * (1 - smooth(wall / WALL_AO_M))));
      }
      if (uvs !== null) {
        uvs[(at / 3) * 2] = x;
        uvs[(at / 3) * 2 + 1] = z;
      }
      positions[at] = x;
      positions[at + 2] = z;
      colors[at] = color.r;
      colors[at + 1] = color.g;
      colors[at + 2] = color.b;
      normals[at + 1] = 1;
      at += 3;
    }
  }
  // Stejná šířka indexu, jakou by zvolil `setIndex(number[])` (Uint32 až od indexu 65535).
  const index = count > 65535 ? new Uint32Array(rows * columns * 6) : new Uint16Array(rows * columns * 6);
  let next = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * (columns + 1) + column;
      const c = a + columns + 1;
      index[next] = a;
      index[next + 1] = c;
      index[next + 2] = a + 1;
      index[next + 3] = a + 1;
      index[next + 4] = c;
      index[next + 5] = c + 1;
      next += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  if (uvs !== null) geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

/**
 * Boční řez podstavce podle krytu sady (P73D T3): barva vrstvy pod hranou a u dna.
 * Hlína pod trávou, pískovec, led pod sněhem, kvádry pod dlažbou, kámen.
 */
const CUT: Readonly<Record<Cover, readonly [top: string, bottom: string]>> = {
  grass: ['#7a5534', '#3d2a1c'],
  sand: ['#d8b98a', '#9c7448'],
  snow: ['#dbe7ef', '#6f8796'],
  paving: ['#a8a29e', '#57534e'],
  rock: ['#8a817a', '#44403c'],
};
/** Poloměr zaoblené hrany (m), hloubka bočního řezu pod zemí (m), kroky oblouku hrany a rohu. */
export const PODIUM_RIM_M = 0.8;
export const PODIUM_DEPTH_M = 3;
const RIM_STEPS = 4;
const CORNER_STEPS = 4;
/** Vrstvy bočního řezu pod obloukem hrany (pruhy hlíny, kamene). */
const CUT_LAYERS = [0.12, 0.3, 0.5, 0.72, 1] as const;
/** Krok podél hrany (m): pruhy řezu se vlní, ať podstavec není čistý kvádr. */
const PODIUM_STEP_M = 2.5;

/**
 * Podstavec diorama (P73D T3) kolem rovné země `area`: hrana se zaobluje dolů (`PODIUM_RIM_M`),
 * pod ní boční řez materiálu sady (`CUT`) do `PODIUM_DEPTH_M`, v rozích půdorysu oblouk. Za ním
 * je pozadí, ne další dlažba do mlhy. Barvy ve vrcholech: hrana v barvě země `base`, řez
 * v pruzích z šumu, u dna tmavne. Čistá funkce `area` – jádro o podstavci neví, hash se nehne.
 */
export function buildPodium(look: Look, area: Box, base: string = look.ground): BufferGeometry {
  const [cutTop, cutBottom] = CUT[look.cover].map((hex) => new Color(mix(hex, base, 0.2))) as [Color, Color];
  const lip = new Color(groundPalette(look, base).light);
  // Obrys: rohy proti směru hodinových ručiček, v každém vějíř normál od jedné strany k druhé, mezi nimi rovná hrana po krocích.
  const corners = [
    [area.x1, area.z0, -Math.PI / 2],
    [area.x1, area.z1, 0],
    [area.x0, area.z1, Math.PI / 2],
    [area.x0, area.z0, Math.PI],
  ] as const;
  const path: [x: number, z: number, nx: number, nz: number][] = [];
  corners.forEach(([x, z, from], i) => {
    for (let k = 0; k <= CORNER_STEPS; k += 1) {
      const angle = from + ((Math.PI / 2) * k) / CORNER_STEPS;
      path.push([x, z, Math.cos(angle), Math.sin(angle)]);
    }
    const [nx, nz] = corners[(i + 1) % 4]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, nz - z) / PODIUM_STEP_M));
    const [ox, oz] = [Math.cos(from + Math.PI / 2), Math.sin(from + Math.PI / 2)];
    for (let k = 1; k < steps; k += 1) path.push([x + ((nx - x) * k) / steps, z + ((nz - z) * k) / steps, ox, oz]);
  });
  // Profil (odstup ven, výška, barva): oblouk hrany, pak svislý řez ve vrstvách.
  const profile: [out: number, y: number, paint: (along: number, target: Color) => Color][] = [];
  for (let k = 0; k <= RIM_STEPS; k += 1) {
    const angle = ((Math.PI / 2) * k) / RIM_STEPS;
    profile.push([PODIUM_RIM_M * Math.sin(angle), -PODIUM_RIM_M * (1 - Math.cos(angle)), (_, target) => target.copy(lip).lerp(cutTop, k / RIM_STEPS)]);
  }
  for (const depth of CUT_LAYERS) {
    const y = -PODIUM_RIM_M - (PODIUM_DEPTH_M - PODIUM_RIM_M) * depth;
    profile.push([PODIUM_RIM_M, y, (along, target) => target.copy(cutTop).lerp(cutBottom, depth).multiplyScalar((0.86 + 0.24 * noise(along * 0.15, y * 1.7)) * (depth === 1 ? 0.6 : 1))]);
  }
  const positions = new Float32Array(path.length * profile.length * 3);
  const colors = new Float32Array(positions.length);
  const color = new Color();
  let at = 0;
  path.forEach(([x, z, nx, nz]) => {
    for (const [out, y, paint] of profile) {
      paint(x * 0.7 + z * 1.3, color);
      positions[at] = x + nx * out;
      positions[at + 1] = y;
      positions[at + 2] = z + nz * out;
      colors[at] = color.r;
      colors[at + 1] = color.g;
      colors[at + 2] = color.b;
      at += 3;
    }
  });
  const rings = profile.length;
  const index: number[] = [];
  for (let p = 0; p < path.length; p += 1) {
    const q = (p + 1) % path.length;
    for (let r = 0; r + 1 < rings; r += 1) {
      const [a, b, c, d] = [p * rings + r, q * rings + r, p * rings + r + 1, q * rings + r + 1];
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** Odstup sloupců země závodu od kraje cesty (m): hustě u krajnice, řídce do dálky. Krok řad podél trati (m). */
const ROAD_COLUMNS = [0, 0.7, 1.5, 2.5, 3.5, 5, 7, 10, 14, 20, 28, 39, 53, 68, 86];
const ROAD_ROW_M = 2;
/**
 * Krajnice závodu je širší než u běžce: kamera jede nízko za autem a mantinel
 * (0,8 m) za sebou schová skoro dva metry země – úzký pás by zmizel celý.
 */
const ROAD_VERGE_M = 3;

/**
 * Zem závodu: mřížka podél osy cesty (`stripCurve`) od `from` do `to`, sloupce
 * v odstupu od kraje cesty, barvy ve vrcholech. Leží v y = 0, normála nahoru.
 */
export function buildRoadGround(look: Look, segments: readonly StripSegment[], from: number, to: number): BufferGeometry {
  const curve = stripCurve(segments);
  const paint = groundPainter(groundPalette(look), ROAD_VERGE_M);
  // Sloupec = (strana, odstup od kraje); prostřední leží pod cestou.
  const columns: readonly (readonly [side: number, offset: number])[] = [...ROAD_COLUMNS.map((d) => [-1, d] as const).reverse(), [0, 0], ...ROAD_COLUMNS.map((d) => [1, d] as const)];
  const rows = Math.max(1, Math.ceil((to - from) / ROAD_ROW_M));
  const positions = new Float32Array((rows + 1) * columns.length * 3);
  const colors = new Float32Array(positions.length);
  const color = new Color();
  for (let row = 0; row <= rows; row += 1) {
    const z = Math.min(to, from + row * ROAD_ROW_M);
    const { center, width } = curve(z);
    columns.forEach(([side, offset], column) => {
      const x = center + side * (width / 2 + offset);
      paint(x, z, side === 0 ? -width / 2 : offset, color);
      const at = (row * columns.length + column) * 3;
      positions.set([x, 0, z], at);
      colors.set([color.r, color.g, color.b], at);
    });
  }
  const index: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column + 1 < columns.length; column += 1) {
      const a = row * columns.length + column;
      const [b, c, d] = [a + 1, a + columns.length, a + columns.length + 1];
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
