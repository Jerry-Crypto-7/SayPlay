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
 * Složí kus z dílů a **zapeče ploché normály do geometrie**.
 *
 * `MeshToonMaterial` nemá `flatShading` (past z `CLAUDE.md`), takže se na
 * materiál nedá spolehnout. Výsledek je proto neindexovaný a normály se
 * počítají až nad ním — `computeVertexNormals()` nad neindexovanou geometrií
 * dá všem třem vrcholům trojúhelníku tutéž normálu plochy a žádná normála se
 * mezi trojúhelníky nesdílí.
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
  geometry.computeVertexNormals();
  return geometry;
}
