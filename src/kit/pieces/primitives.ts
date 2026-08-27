import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  LinearSRGBColorSpace,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';

/**
 * Základní paleta kitu v **sRGB**. Do geometrie se nikdy nezapisuje takhle —
 * `COLOR_0` je podle glTF spec lineární, takže hodnoty projdou
 * `convertSRGBToLinear()` v `srgbHexToLinear()`. Zápis surových sRGB čísel je
 * ta past, kvůli které paleta vypadá vybledle a nikdo neví proč.
 *
 * Žádný fialový ani purpurový odstín — globální pravidlo designu.
 */
export const SWATCHES = {
  shell: '#8d9ba1',
  deep: '#3c4a50',
  accent: '#2f9e8f',
  warm: '#d08a3c',
  sand: '#c9b48a',
  moss: '#6f8f5a',
} as const;

export type SwatchName = keyof typeof SWATCHES;

export type PieceCategory =
  | 'mass'
  | 'column'
  | 'arch'
  | 'panel'
  | 'fixture'
  | 'organic'
  | 'actor';

export type Piece = {
  readonly id: string;
  readonly category: PieceCategory;
  /** Vrací pokaždé čerstvou geometrii — volající ji vlastní a smí ji uvolnit. */
  readonly build: () => BufferGeometry;
};

export type Part = {
  readonly geometry: BufferGeometry;
  readonly swatch: SwatchName;
  readonly position?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
};

/**
 * sRGB hex → lineární trojice.
 *
 * Konverze jde přes `setRGB(..., LinearSRGBColorSpace)`, což hodnoty uloží
 * beze změny (zdrojový a pracovní prostor jsou tentýž), a teprve pak přes
 * `convertSRGBToLinear()`. Ta objížďka je záměrná: `new Color('#rrggbb')`
 * konvertuje podle globálního `ColorManagement.enabled`, takže by výsledek
 * kitu záležel na nastavení, které je jinde v aplikaci a může se změnit.
 */
export function srgbHexToLinear(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const color = new Color().setRGB(
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
    LinearSRGBColorSpace,
  );
  color.convertSRGBToLinear();
  return [color.r, color.g, color.b];
}

/**
 * Nad kolika stupni mezi dvěma plochami zůstane hrana ostrá.
 *
 * **Číslo je naměřené na kitu, ne opsané z návrhu.** Válce kitu mají osm
 * radiálních segmentů, takže mezi sousedními bočními plochami je přesně 45°;
 * ikosaedr má mezi sousedními plochami 41,8°. Práh 35° z původního zadání by
 * tedy nesladil ani jeden kus a míchané stínování by neexistovalo. Krychle má
 * 90°, takže hranaté kusy zůstávají hranaté i při 50°.
 */
export const SMOOTH_ANGLE_DEGREES = 50;

/** Klíč vrcholu pro sdílení normál. Barva je jeho součástí schválně — viz níž. */
function vertexKey(x: number, y: number, z: number, r: number, g: number, b: number): string {
  const q = (v: number) => Math.round(v * 1e5);
  return `${q(x)},${q(y)},${q(z)}|${q(r)},${q(g)},${q(b)}`;
}

/**
 * Míchané stínování: hladké tam, kde je plocha zaoblená, ostré na hranách.
 *
 * Normála vrcholu se skládá z ploch, které se v něm potkávají — ale jen z těch,
 * které od jeho vlastní plochy neuhýbají víc než `SMOOTH_ANGLE_DEGREES`. Ostré
 * hrany tak zůstanou ostré, protože se přes ně nic neprůměruje, a bok válce se
 * slije, protože sousední segmenty jsou blízko.
 *
 * **Barva je součástí klíče, takže rozhraní dvou odstínů je vždy ostré.** Bez
 * toho by se normály přelily přes hranici obruče a sudu, kde se sejdou dvě
 * plochy skoro stejného sklonu, a hrana barvy by se rozmazala do gradientu —
 * což je přesně to, co u toon materiálu vypadá jako vada vykreslení.
 */
function mixedNormals(positions: readonly number[], colors: readonly number[]): Float32Array {
  const triangles = positions.length / 9;
  const faces = new Float32Array(triangles * 3);
  const ax = new Vector3();
  const bx = new Vector3();
  const cx = new Vector3();
  const edge1 = new Vector3();
  const edge2 = new Vector3();
  const face = new Vector3();

  for (let t = 0; t < triangles; t += 1) {
    const o = t * 9;
    ax.set(positions[o], positions[o + 1], positions[o + 2]);
    bx.set(positions[o + 3], positions[o + 4], positions[o + 5]);
    cx.set(positions[o + 6], positions[o + 7], positions[o + 8]);
    edge1.subVectors(bx, ax);
    edge2.subVectors(cx, ax);
    face.crossVectors(edge1, edge2);
    // Zdegenerovaný trojúhelník nemá normálu; nechá se nulová, aby se do
    // sousedů nepřičetlo `NaN` a nezčernal kus jako celek.
    if (face.lengthSq() > 0) face.normalize();
    faces[t * 3] = face.x;
    faces[t * 3 + 1] = face.y;
    faces[t * 3 + 2] = face.z;
  }

  const buckets = new Map<string, number[]>();
  for (let v = 0; v < triangles * 3; v += 1) {
    const p = v * 3;
    const key = vertexKey(
      positions[p],
      positions[p + 1],
      positions[p + 2],
      colors[p],
      colors[p + 1],
      colors[p + 2],
    );
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [v]);
    else bucket.push(v);
  }

  const limit = Math.cos((SMOOTH_ANGLE_DEGREES * Math.PI) / 180);
  const normals = new Float32Array(triangles * 9);
  const sum = new Vector3();

  for (const bucket of buckets.values()) {
    for (const v of bucket) {
      const own = Math.floor(v / 3) * 3;
      sum.set(0, 0, 0);
      for (const other of bucket) {
        const face = Math.floor(other / 3) * 3;
        const dot =
          faces[own] * faces[face] + faces[own + 1] * faces[face + 1] + faces[own + 2] * faces[face + 2];
        if (dot < limit) continue;
        sum.x += faces[face];
        sum.y += faces[face + 1];
        sum.z += faces[face + 2];
      }
      if (sum.lengthSq() === 0) sum.set(faces[own], faces[own + 1], faces[own + 2]);
      else sum.normalize();
      normals[v * 3] = sum.x;
      normals[v * 3 + 1] = sum.y;
      normals[v * 3 + 2] = sum.z;
    }
  }

  return normals;
}

/**
 * Složí kus z dílů a **zapeče normály do geometrie**.
 *
 * `MeshToonMaterial` nemá `flatShading` (past z `CLAUDE.md`), takže se na
 * materiál nedá spolehnout — stínování musí nést geometrie. Výsledek je proto
 * neindexovaný a normály se počítají až nad ním.
 *
 * Do 20. 8. 2026 to dělalo `computeVertexNormals()`, které nad neindexovanou
 * geometrií dá všem třem vrcholům tutéž normálu plochy, takže **všechno** bylo
 * fasetované — i bok válce, který má být hladký. Teď to dělá `mixedNormals`:
 * hladce tam, kde je oblina, ostře na hranách a vždy ostře na rozhraní barev.
 */
export function assemble(parts: readonly Part[]): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const matrix = new Matrix4();
  const quaternion = new Quaternion();

  for (const part of parts) {
    const [px, py, pz] = part.position ?? [0, 0, 0];
    const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
    const [sx, sy, sz] = part.scale ?? [1, 1, 1];

    quaternion.setFromEuler(new Euler(rx, ry, rz));
    matrix.compose(new Vector3(px, py, pz), quaternion, new Vector3(sx, sy, sz));

    // `IcosahedronGeometry` a spol. jsou neindexované už od výroby a
    // `toNonIndexed()` by na nich jen varovalo.
    const placed = part.geometry.clone().applyMatrix4(matrix);
    const transformed = placed.index === null ? placed : placed.toNonIndexed();
    const position = transformed.getAttribute('position');
    const [r, g, b] = srgbHexToLinear(SWATCHES[part.swatch]);

    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      colors.push(r, g, b);
    }

    if (transformed !== placed) placed.dispose();
    transformed.dispose();
    part.geometry.dispose();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('normal', new BufferAttribute(mixedNormals(positions, colors), 3));
  return geometry;
}
