import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { BufferAttribute, BufferGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three';

import { SWATCHES, pieceById, srgbHexToLinear, type SwatchName } from '../kit';
import {
  parseGeomProgram,
  pieceIdOf,
  type GeomNode,
  type GeomProgram,
} from './program';

/**
 * Kompilátor druhé větve mezijazyka: z programu udělá jednu `BufferGeometry`.
 *
 * **Ručně psaný a deterministický.** Model program napíše, tenhle soubor ho
 * vykoná — nikde se nevolá nic, co by model dodal jako kód. Dvakrát tentýž
 * program dá bajt po bajtu tutéž geometrii; náhoda v `scatter` a v terénu jde
 * výhradně přes `pure-rand` se semínkem z dokumentu.
 *
 * **Normály se nepočítají znovu.** Kusy kitu si je nesou zapečené z
 * `assemble()`, které umí míchané stínování (hladko na oblinách, ostro na
 * hranách a vždy ostro na rozhraní barev). `computeVertexNormals()` nad
 * sloučeným světem by je přepsalo na fasety a navíc by slilo normály dvou
 * různých kusů, které se dotýkají — proto se transformují spolu s pozicemi a
 * nic víc se s nimi nedělá. Zadání T9 mluví o `computeVertexNormals()`, ale to
 * je popis stavu před 20. 8. 2026; `src/kit/pieces/primitives.ts` ho tehdy
 * nahradil právě proto, že fasetoval i bok válce.
 *
 * Vrchní barvy jdou do atributu `color` už z kitu v **lineárním** prostoru
 * (`srgbHexToLinear`), takže je `repaint()` z palet umí přebarvit. Terén proto
 * používá odstíny kitu, ne vlastní: `repaint()` na barvě mimo kit vyhodí.
 */

/** Odstín kitu pro každý druh terénu. Musí to být odstín z `SWATCHES` — viz `repaint()`. */
const TERRAIN_SWATCH: Readonly<Record<string, SwatchName>> = {
  flat: 'sand',
  ridge: 'shell',
  basin: 'moss',
  plateau: 'deep',
};

type Attributes = {
  readonly position: Float32Array;
  readonly color: Float32Array;
  readonly normal: Float32Array;
};

function attributesOf(geometry: BufferGeometry): Attributes {
  return {
    position: geometry.getAttribute('position').array as Float32Array,
    color: geometry.getAttribute('color').array as Float32Array,
    normal: geometry.getAttribute('normal').array as Float32Array,
  };
}

function fromAttributes(attributes: Attributes): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(attributes.position, 3));
  geometry.setAttribute('color', new BufferAttribute(attributes.color, 3));
  geometry.setAttribute('normal', new BufferAttribute(attributes.normal, 3));
  return geometry;
}

/** Sloučí geometrie do jedné a **vstupy uvolní** — volající je už nepotřebuje. */
function concat(parts: readonly BufferGeometry[]): BufferGeometry {
  const lengths = parts.map((part) => (part.getAttribute('position').array as Float32Array).length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const merged: Attributes = {
    position: new Float32Array(total),
    color: new Float32Array(total),
    normal: new Float32Array(total),
  };

  let offset = 0;
  parts.forEach((part, index) => {
    const source = attributesOf(part);
    merged.position.set(source.position, offset);
    merged.color.set(source.color, offset);
    merged.normal.set(source.normal, offset);
    offset += lengths[index];
    part.dispose();
  });

  return fromAttributes(merged);
}

/**
 * Obrátí pořadí vrcholů v každém trojúhelníku.
 *
 * Zrcadlení má záporný determinant, takže po něm je vinutí opačné a
 * `MeshToonMaterial` s výchozím `side: FrontSide` by zrcadlenou půlku
 * odřízl jako odvrácenou. Normály se přitom nechávají tak, jak je nechal
 * `applyMatrix4` — po obrácení vinutí zase míří ven.
 */
function flipWinding(geometry: BufferGeometry): void {
  const { position, color, normal } = attributesOf(geometry);
  for (let vertex = 0; vertex < position.length; vertex += 9) {
    for (const array of [position, color, normal]) {
      for (let axis = 0; axis < 3; axis += 1) {
        const first = vertex + 3 + axis;
        const second = vertex + 6 + axis;
        const swap = array[first];
        array[first] = array[second];
        array[second] = swap;
      }
    }
  }
}

function placementMatrix(
  at: readonly [number, number, number] | undefined,
  yaw: number | undefined,
  scale: readonly [number, number, number] | undefined,
): Matrix4 {
  const [x, y, z] = at ?? [0, 0, 0];
  const [sx, sy, sz] = scale ?? [1, 1, 1];
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(0, ((yaw ?? 0) * Math.PI) / 2, 0)),
    new Vector3(sx, sy, sz),
  );
}

/**
 * Umístí kus. Uzel bez jediného údaje o umístění se **nechá být** — jednotková
 * matice by jen prohnala všechny vrcholy i normály `applyMatrix4` pro nic.
 */
function place(
  geometry: BufferGeometry,
  at: readonly [number, number, number] | undefined,
  yaw: number | undefined,
  scale: readonly [number, number, number] | undefined,
): BufferGeometry {
  if (at === undefined && yaw === undefined && scale === undefined) return geometry;
  return geometry.applyMatrix4(placementMatrix(at, yaw, scale));
}

/** Výška terénu v bodě `[u, v]`, kde obojí běží od −1 do 1. */
function terrainHeight(variant: string, u: number, v: number): number {
  switch (variant) {
    case 'ridge':
      return 1 - Math.abs(v);
    case 'basin':
      return (u * u + v * v) / 2;
    case 'plateau': {
      const distance = Math.min(1, Math.hypot(u, v));
      // Hladký sestup od poloviny poloměru k okraji: uprostřed rovná plošina.
      const fall = Math.max(0, Math.min(1, (distance - 0.5) / 0.5));
      return 1 - fall * fall * (3 - 2 * fall);
    }
    default:
      return 0;
  }
}

/**
 * Zem jako výškové pole. Jediný tvar, který se negeneruje z kusu kitu.
 *
 * Normály jsou **ploché, po trojúhelníku** — zem je krajina, ne kus s oblinou,
 * a fasety na ní jsou záměr, ne vada. Nerovnost ze semínka se počítá jednou do
 * mřížky vrcholů, takže sousední trojúhelníky sdílejí tutéž výšku a v zemi
 * nevznikne trhlina.
 */
function terrainGeometry(node: Extract<GeomNode, { kind: 'terrain' }>): BufferGeometry {
  const [width, depth] = node.extent;
  // Jeden dílek na dvě pole mřížky. Strop `extent` v schématu je 64, takže
  // nejhustší zem má 32 dílků na osu = 2048 trojúhelníků — vlastní strop dílků
  // by tu tedy nic nechránil.
  const columns = Math.max(2, Math.round(width / 2));
  const rows = Math.max(2, Math.round(depth / 2));

  const stream = xoroshiro128plus(node.seed);
  const jitter = node.amplitude * 0.15;
  const heights: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const u = (column / columns) * 2 - 1;
      const v = (row / rows) * 2 - 1;
      const noise = jitter === 0 ? 0 : (uniformInt(stream, 0, 1000) / 1000 - 0.5) * jitter;
      heights.push(node.amplitude * terrainHeight(node.variant, u, v) + noise);
    }
  }

  const corner = (row: number, column: number): readonly [number, number, number] => [
    (column / columns - 0.5) * width,
    heights[row * (columns + 1) + column],
    (row / rows - 0.5) * depth,
  ];

  const position: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = corner(row, column);
      const b = corner(row + 1, column);
      const c = corner(row + 1, column + 1);
      const d = corner(row, column + 1);
      position.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }

  const [r, g, b] = srgbHexToLinear(SWATCHES[TERRAIN_SWATCH[node.variant]]);
  const color = new Float32Array(position.length);
  for (let index = 0; index < color.length; index += 3) {
    color[index] = r;
    color[index + 1] = g;
    color[index + 2] = b;
  }

  return fromAttributes({
    position: new Float32Array(position),
    color,
    normal: flatNormals(position),
  });
}

/** Normála plochy na všechny tři vrcholy trojúhelníku. */
function flatNormals(position: readonly number[]): Float32Array {
  const normal = new Float32Array(position.length);
  const edge1 = new Vector3();
  const edge2 = new Vector3();
  const face = new Vector3();

  for (let triangle = 0; triangle < position.length; triangle += 9) {
    edge1.set(
      position[triangle + 3] - position[triangle],
      position[triangle + 4] - position[triangle + 1],
      position[triangle + 5] - position[triangle + 2],
    );
    edge2.set(
      position[triangle + 6] - position[triangle],
      position[triangle + 7] - position[triangle + 1],
      position[triangle + 8] - position[triangle + 2],
    );
    face.crossVectors(edge1, edge2);
    if (face.lengthSq() > 0) face.normalize();
    for (let vertex = 0; vertex < 9; vertex += 3) {
      normal[triangle + vertex] = face.x;
      normal[triangle + vertex + 1] = face.y;
      normal[triangle + vertex + 2] = face.z;
    }
  }

  return normal;
}

/**
 * Řez kvádrem: zahodí trojúhelníky, jejichž těžiště padne dovnitř.
 *
 * Není to booleovský rozdíl — okraj díry zůstane roztřepený po hranicích
 * trojúhelníků a stěna se nedopočítá. Na průchod prosekaný do zdi to stačí a
 * nestojí to novou závislost, což CSG stálo by.
 */
function carve(
  source: BufferGeometry,
  at: readonly [number, number, number],
  size: readonly [number, number, number],
): BufferGeometry {
  const { position, color, normal } = attributesOf(source);
  const half: readonly number[] = size.map((side) => side / 2);
  const keptPosition: number[] = [];
  const keptColor: number[] = [];
  const keptNormal: number[] = [];

  for (let triangle = 0; triangle < position.length; triangle += 9) {
    const inside = [0, 1, 2].every((axis) => {
      const centroid =
        (position[triangle + axis] + position[triangle + 3 + axis] + position[triangle + 6 + axis]) / 3;
      return Math.abs(centroid - at[axis]) <= half[axis];
    });
    if (inside) continue;

    for (let offset = 0; offset < 9; offset += 1) {
      keptPosition.push(position[triangle + offset]);
      keptColor.push(color[triangle + offset]);
      keptNormal.push(normal[triangle + offset]);
    }
  }

  source.dispose();
  return fromAttributes({
    position: new Float32Array(keptPosition),
    color: new Float32Array(keptColor),
    normal: new Float32Array(keptNormal),
  });
}

function buildNode(node: GeomNode, built: readonly BufferGeometry[]): BufferGeometry {
  switch (node.kind) {
    case 'terrain':
      return place(terrainGeometry(node), node.at, node.yaw, undefined);

    case 'group':
      return concat(node.children.map((child) => built[child].clone()));

    case 'repeat':
      return concat(
        Array.from({ length: node.count }, (_unused, step) => {
          const copy = built[node.child].clone();
          const [dx, dy, dz] = node.step;
          return copy.applyMatrix4(new Matrix4().makeTranslation(dx * step, dy * step, dz * step));
        }),
      );

    case 'mirror': {
      const about = node.about ?? 0;
      const reflection =
        node.axis === 'x'
          ? new Matrix4().makeTranslation(2 * about, 0, 0).multiply(new Matrix4().makeScale(-1, 1, 1))
          : new Matrix4().makeTranslation(0, 0, 2 * about).multiply(new Matrix4().makeScale(1, 1, -1));
      const reflected = built[node.child].clone().applyMatrix4(reflection);
      flipWinding(reflected);
      return concat([built[node.child].clone(), reflected]);
    }

    case 'carve':
      return carve(built[node.child].clone(), node.at, node.size);

    case 'scatter': {
      const stream = xoroshiro128plus(node.seed);
      return concat(
        Array.from({ length: node.count }, () => {
          // Odmocnina z rovnoměrného čísla rozprostře kopie po ploše kruhu.
          // Bez ní se kupí u středu, protože obvodu přibývá s poloměrem.
          const angle = (uniformInt(stream, 0, 3599) / 3600) * Math.PI * 2;
          const distance = node.radius * Math.sqrt(uniformInt(stream, 0, 1000) / 1000);
          const yaw = uniformInt(stream, 0, 3);
          const matrix = placementMatrix(
            [Math.cos(angle) * distance, 0, Math.sin(angle) * distance],
            yaw,
            undefined,
          );
          return built[node.child].clone().applyMatrix4(matrix);
        }),
      );
    }

    default: {
      const id = pieceIdOf(node.kind, node.variant);
      const piece = pieceById(id);
      if (piece === undefined) throw new Error(`program odkazuje na kus ${id}, který v kitu není`);
      return place(piece.build(), node.at, node.yaw, node.scale);
    }
  }
}

export function trianglesOfGeometry(geometry: BufferGeometry): number {
  return (geometry.getAttribute('position').array as Float32Array).length / 9;
}

/**
 * Program → geometrie.
 *
 * Průchod odspodu nahoru: potomek má vždy nižší index než rodič, což vynutil
 * `parseGeomProgram`, takže se nikde nerekurzuje a cyklus nemá jak vzniknout.
 * Mezivýsledky, které v kořeni neskončily, se uvolní — jinak by v prohlížeči
 * zůstaly viset buffery po každém přeložení věty.
 */
export function compileGeomProgram(input: GeomProgram | unknown): BufferGeometry {
  const program = parseGeomProgram(input);

  const built: BufferGeometry[] = [];
  program.nodes.forEach((node, index) => {
    built[index] = buildNode(node, built);
  });

  const root = built[program.root];
  built.forEach((geometry, index) => {
    if (index !== program.root) geometry.dispose();
  });

  if (trianglesOfGeometry(root) === 0) {
    throw new Error('program compiled to an empty geometry: nothing is left after the carves');
  }

  root.computeBoundingBox();
  root.computeBoundingSphere();
  return root;
}
