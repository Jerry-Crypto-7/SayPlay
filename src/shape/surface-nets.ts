/**
 * Meshovač — z pole vzdáleností udělá trojúhelníky.
 *
 * ## Proč surface nets a ne marching cubes
 *
 * Marching cubes má tabulku 256 případů, staví vrcholy **na hranách** buňky a
 * dělá dlouhé tenké trojúhelníky. Surface nets staví **jeden vrchol do buňky**,
 * posunutý na průměr průsečíků, a spojuje sousední buňky do čtyřúhelníků.
 * Výsledek má zhruba poloviční počet trojúhelníků, rovnoměrnější síť a žádnou
 * tabulku, kterou by bylo možné opsat špatně.
 *
 * Cena je, že povrch je mírně vyhlazený proti přesné nulové hladině — ostrá
 * hrana kvádru se zakulatí zhruba o půl buňky. Pro hrubou hlínu, která pak
 * ztvrdne v jemnější mřížce, je to ta správná výměna.
 *
 * ## Normály se počítají z pole, ne z trojúhelníků
 *
 * Normála z trojúhelníků je průměr ploch, které se kolem vrcholu sešly, takže
 * na hrubé mřížce nese fasety mřížky, ne tvar. Gradient pole je naopak přesná
 * normála **toho tělesa**, nezávislá na rozlišení — a je to jediný důvod, proč
 * tentýž objekt vypadá po přemeshování v jemnější mřížce jako on sám, jen
 * ostřejší. To je celý slib hot-swapu z vlny 3.
 */

import { createField, type Field } from './field';
import type { Bounds3, ShapeProgram, Vec3 } from './types';

/**
 * Osm rohů buňky. Bit 0 je `x`, bit 1 je `y`, bit 2 je `z` — takže roh číslo
 * `1 << osa` je soused podél té osy, což využívá smyčka pro čtyřúhelníky.
 */
const CORNER_OFFSETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

/** Dvanáct hran buňky jako dvojice rohů. */
const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

export interface MeshRequest {
  /** Kolik buněk na osu. Mřížka vzorků je o jednu větší. */
  readonly resolution: number;
  /**
   * Kvádr, ve kterém se hledá povrch — **už včetně rezervy**.
   *
   * `meshShapeProgram()` bere tenhle kvádr doslova a rezervu si nepřidává;
   * kdo mele přes `handleMeshJob()`, dostane ji od workeru (viz `paddedBounds`).
   * Kdo volá meshovač přímo — testy a referenční sada — si o ni musí říct sám,
   * jinak měří tvar, který svůj kvádr vyplnil, jako prázdno.
   */
  readonly bounds: Bounds3;
}

export interface ShapeMesh {
  /** Tři čísla na vrchol. */
  readonly positions: Float32Array;
  /** Tři čísla na vrchol, jednotkové. */
  readonly normals: Float32Array;
  /** Tři indexy na trojúhelník. */
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Kvádr opsaný **hotovému meshi**, ne zadání. Prázdný mesh ho má obrácený. */
  readonly bounds: Bounds3;
}

/** Prázdný výsledek — program, jehož povrch do zadaného kvádru nezasáhl. */
function emptyMesh(): ShapeMesh {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    vertexCount: 0,
    triangleCount: 0,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

/**
 * Vzorkuje pole do mřížky `(resolution + 1)³`.
 *
 * Je to jediný průchod a jediná velká alokace celého meshingu. Vzorky se
 * **nepočítají dvakrát**: každý roh sdílí až osm buněk, takže vzorkovat po
 * buňkách by znamenalo osminásobek vyhodnocení pole, což je nejdražší část.
 */
export function sampleField(field: Field, request: MeshRequest): Float32Array {
  const { resolution, bounds } = request;
  const side = resolution + 1;
  const samples = new Float32Array(side * side * side);

  const stepX = (bounds.max[0] - bounds.min[0]) / resolution;
  const stepY = (bounds.max[1] - bounds.min[1]) / resolution;
  const stepZ = (bounds.max[2] - bounds.min[2]) / resolution;

  let index = 0;
  for (let k = 0; k < side; k += 1) {
    const z = bounds.min[2] + stepZ * k;
    for (let j = 0; j < side; j += 1) {
      const y = bounds.min[1] + stepY * j;
      for (let i = 0; i < side; i += 1) {
        samples[index] = field.at(bounds.min[0] + stepX * i, y, z);
        index += 1;
      }
    }
  }
  return samples;
}

/**
 * Naivní surface nets nad hotovou mřížkou vzorků.
 *
 * Dva průchody. První najde buňky, kterými prochází povrch, a položí do každé
 * jeden vrchol. Druhý — vnořený do prvního — spojí čtyři buňky kolem každé
 * hrany se změnou znaménka do čtyřúhelníku. Buňky se procházejí vzestupně,
 * takže tři ze čtyř sousedů už vrchol mají; proto se ptáme jen dozadu.
 */
export function surfaceNets(
  samples: Float32Array,
  field: Field,
  request: MeshRequest,
): ShapeMesh {
  const { resolution, bounds } = request;
  const side = resolution + 1;

  const stepX = (bounds.max[0] - bounds.min[0]) / resolution;
  const stepY = (bounds.max[1] - bounds.min[1]) / resolution;
  const stepZ = (bounds.max[2] - bounds.min[2]) / resolution;

  // Index vrcholu pro každou buňku, nebo −1. `Int32Array` místo mapy: mřížka je
  // hustá a hledání souseda musí být jedno čtení, ne hash.
  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);

  const positions: number[] = [];
  const indices: number[] = [];

  const cornerValues = new Float64Array(8);

  // Krok v `cellVertex` po jednotlivých osách. Je to konstanta celé mřížky,
  // takže se počítá jednou — uvnitř trojité smyčky by to bylo pole na buňku.
  const strideX = 1;
  const strideY = resolution;
  const strideZ = resolution * resolution;

  for (let k = 0; k < resolution; k += 1) {
    for (let j = 0; j < resolution; j += 1) {
      for (let i = 0; i < resolution; i += 1) {
        let mask = 0;
        for (let c = 0; c < 8; c += 1) {
          const [ox, oy, oz] = CORNER_OFFSETS[c];
          const value = samples[(k + oz) * side * side + (j + oy) * side + (i + ox)];
          cornerValues[c] = value;
          if (value < 0) mask |= 1 << c;
        }

        // Celá buňka uvnitř nebo celá venku — povrch tudy nejde.
        if (mask === 0 || mask === 255) continue;

        // Vrchol je průměr průsečíků na hranách. Průsečík se hledá lineárně,
        // což je přesné potud, pokud je pole v buňce zhruba lineární — a to je
        // právě to, co zaručuje pravidlo „vzdálenost se nenadstřeluje".
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let crossings = 0;
        for (let e = 0; e < 12; e += 1) {
          const [a, b] = EDGE_CORNERS[e];
          const va = cornerValues[a];
          const vb = cornerValues[b];
          if (va < 0 === vb < 0) continue;

          const t = va / (va - vb);
          const [ax, ay, az] = CORNER_OFFSETS[a];
          const [bx, by, bz] = CORNER_OFFSETS[b];
          sumX += ax + (bx - ax) * t;
          sumY += ay + (by - ay) * t;
          sumZ += az + (bz - az) * t;
          crossings += 1;
        }

        const vertexIndex = positions.length / 3;
        cellVertex[k * strideZ + j * strideY + i] = vertexIndex;
        positions.push(
          bounds.min[0] + (i + sumX / crossings) * stepX,
          bounds.min[1] + (j + sumY / crossings) * stepY,
          bounds.min[2] + (k + sumZ / crossings) * stepZ,
        );

        // Tři hrany vycházející z rohu 0. Každá, na které se mění znaménko,
        // nese jeden čtyřúhelník ze čtyř buněk, které se o ni dělí.
        for (let axis = 0; axis < 3; axis += 1) {
          const neighbourCorner = 1 << axis;
          if (cornerValues[0] < 0 === cornerValues[neighbourCorner] < 0) continue;

          // Zbylé dvě osy. Buňky „o jednu zpět" po nich musí existovat, jinak
          // je hrana na okraji mřížky a čtyřúhelník kolem ní nemá čtvrtý roh.
          const u = (axis + 1) % 3;
          const v = (axis + 2) % 3;
          const cellU = u === 0 ? i : u === 1 ? j : k;
          const cellV = v === 0 ? i : v === 1 ? j : k;
          if (cellU === 0 || cellV === 0) continue;

          const stepU = u === 0 ? strideX : u === 1 ? strideY : strideZ;
          const stepV = v === 0 ? strideX : v === 1 ? strideY : strideZ;

          const base = k * strideZ + j * strideY + i;
          const q0 = cellVertex[base];
          const q1 = cellVertex[base - stepU];
          const q2 = cellVertex[base - stepU - stepV];
          const q3 = cellVertex[base - stepV];
          if (q1 < 0 || q2 < 0 || q3 < 0) continue;

          // Orientace jde za znaménkem: povrch musí mít normály ven z tělesa.
          if (cornerValues[0] < 0) {
            indices.push(q0, q1, q2, q0, q2, q3);
          } else {
            indices.push(q0, q2, q1, q0, q3, q2);
          }
        }
      }
    }
  }

  if (positions.length === 0) return emptyMesh();

  const vertexCount = positions.length / 3;
  const positionArray = new Float32Array(positions);
  const normalArray = new Float32Array(positions.length);
  const gradient = new Float64Array(3);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let v = 0; v < vertexCount; v += 1) {
    const x = positionArray[v * 3];
    const y = positionArray[v * 3 + 1];
    const z = positionArray[v * 3 + 2];

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;

    field.gradientInto(x, y, z, gradient);
    const length = Math.sqrt(
      gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2],
    );
    if (length < 1e-12) {
      // Plochý gradient znamená, že vrchol sedí v lokálním extrému pole —
      // stane se to na ose souměrnosti. Nula by dala nevykreslitelnou normálu,
      // takže se bere svislice: viditelně špatná normála na jednom vrcholu je
      // lepší než `NaN`, který zčerná celý mesh.
      normalArray[v * 3] = 0;
      normalArray[v * 3 + 1] = 1;
      normalArray[v * 3 + 2] = 0;
    } else {
      normalArray[v * 3] = gradient[0] / length;
      normalArray[v * 3 + 1] = gradient[1] / length;
      normalArray[v * 3 + 2] = gradient[2] / length;
    }
  }

  return {
    positions: positionArray,
    normals: normalArray,
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    bounds: { min: [minX, minY, minZ] as Vec3, max: [maxX, maxY, maxZ] as Vec3 },
  };
}

/**
 * Celá cesta: program → pole → mesh.
 *
 * Tohle je funkce, kterou volá worker. Na hlavním vlákně ji volat **nechtěj** —
 * při 64³ je to 274 625 vyhodnocení pole a prohlížeč po tu dobu nevykreslí ani
 * jeden snímek.
 */
export function meshShapeProgram(
  program: Pick<ShapeProgram, 'nodes' | 'root'>,
  sessionSeed: number,
  request: MeshRequest,
): ShapeMesh {
  const field = createField(program, sessionSeed);
  const samples = sampleField(field, request);
  return surfaceNets(samples, field, request);
}

/**
 * Kvádr zadání s rezervou jedné buňky na každou stranu.
 *
 * **Chrání proti tvaru, který svůj deklarovaný kvádr o kousek přeteče** — a to
 * je běžné, protože `targetBounds` píše model odhadem, ne měřením.
 *
 * Naměřeno 29. 8. 2026 v mřížce 24³ nad kvádrem ⟨−1, 1⟩:
 *
 * | Tvar | Bez rezervy | S rezervou |
 * |---|---|---|
 * | koule `r = 0,999999` | uzavřená, 5 244 trojúhelníků | uzavřená, 4 620 |
 * | koule `r = 1,000001` | **24 volných hran** u pólů | uzavřená |
 * | kvádr `1,999998³` | uzavřený | uzavřený |
 * | kvádr `2,000002³` | **0 trojúhelníků, tvar zmizel** | uzavřený, 6 348 |
 *
 * Poslední řádek je ten důvod. Když těleso vyplní celou mřížku vzorků, žádná
 * buňka nemění znaménko a meshovač poctivě vrátí prázdno — objekt se nerozbije,
 * on **není**. Rezerva to stojí zhruba 12 % trojúhelníků, protože tytéž buňky
 * pokryjí větší objem; to je levné pojištění proti zmizelému hrdinovi.
 *
 * Rezerva naopak **neuzavře** tvar, který přetéká výrazně — ten je useknutý
 * v každém kvádru a řeší se přepočítáním rozměrů, ne rezervou.
 *
 * ## Kdo ji volá
 *
 * Produkčně **jen `handleMeshJob()`** v `mesh-worker.ts`, a to na každou
 * objednávku. Do 2. 9. 2026 ji nevolal nikdo — tahle hlavička tu stála i s tou
 * tabulkou, zatímco `proxy.ts`, `/gallery` i `/dev/mesh-budget` posílaly
 * `targetBounds` syrově. Mimo worker si o ni říkají testy a referenční sada,
 * které meshovač volají přímo.
 */
export function paddedBounds(bounds: Bounds3, resolution: number): Bounds3 {
  const padX = (bounds.max[0] - bounds.min[0]) / resolution;
  const padY = (bounds.max[1] - bounds.min[1]) / resolution;
  const padZ = (bounds.max[2] - bounds.min[2]) / resolution;
  return {
    min: [bounds.min[0] - padX, bounds.min[1] - padY, bounds.min[2] - padZ] as Vec3,
    max: [bounds.max[0] + padX, bounds.max[1] + padY, bounds.max[2] + padZ] as Vec3,
  };
}
