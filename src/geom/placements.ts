import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { Matrix4, type BufferGeometry } from 'three';

import { pieceById } from '../kit';
import {
  anchorTranslation,
  boundsOfGeometry,
  carve,
  concat,
  curveOffsets,
  flipWinding,
  placementMatrix,
  rotationOf,
  terrainGeometry,
  trianglesOfGeometry,
} from './compile';
import { parseGeomProgram, pieceIdOf, type GeomNode, type GeomProgram } from './program';

/**
 * Druhá cesta kompilátoru: z programu udělá **plán rozmístění**, ne jednu síť.
 *
 * `compileGeomProgram()` vrací sloučenou geometrii už ve světových
 * souřadnicích. To scéně nestačí — `WorldScene` staví svět z instancovaných
 * kusů v lokálních souřadnicích a potřebuje matici na každou instanci. Data
 * uvnitř `buildNode()` k tomu existují (`placementMatrix`, `scatter`), jen
 * skončí ve `concat()`. Tenhle soubor je tentýž průchod stromem bez toho
 * posledního kroku.
 *
 * **Slučující cesta zůstává beze změny** a je zároveň orákulum téhle: složením
 * kusů týmiž maticemi musí vyjít vrchol po vrcholu totéž, což pinuje
 * `__tests__/placement.test.ts` nad každým uzlem i nad všemi čtyřmi rodinami.
 *
 * **Dva uzly se na umístěný kus převést nedají** a zůstávají sítí:
 * - `terrain` — zem je výškové pole, kus v kitu pro ni není,
 * - `carve` — řez zahazuje trojúhelníky, takže podstrom po něm přestane být
 *   složeninou kusů.
 *
 * Rozpočet `GEOM_LIMITS.maxInstances` (120) je `maxDrawCallsPerWorld` z kitu,
 * takže délka plánu je rovnou počet draw callů, které scéna zaplatí.
 */

interface PlacementBase {
  /** Do světových souřadnic, včetně všech matic rodičů. */
  readonly matrix: Matrix4;
  /**
   * Matice zrcadlí (záporný determinant). Kdo z plánu peče geometrii, musí
   * obrátit vinutí, jinak `MeshToonMaterial` se `side: FrontSide` půlku
   * odřízne jako odvrácenou.
   */
  readonly mirrored: boolean;
}

/** Kus kitu. Jeden takový záznam = jeden draw call. */
export interface PiecePlacement extends PlacementBase {
  readonly kind: 'piece';
  readonly pieceId: string;
}

/** Co kus kitu není: zem a prosekaný podstrom. */
export interface MeshPlacement extends PlacementBase {
  readonly kind: 'mesh';
  readonly geometry: BufferGeometry;
}

export type GeomPlacement = PiecePlacement | MeshPlacement;

/** Matice rodiče se násobí **zleva** — dítě si svoje umístění nese v sobě. */
function transformed(placement: GeomPlacement, matrix: Matrix4, mirrors = false): GeomPlacement {
  const composed = new Matrix4().multiplyMatrices(matrix, placement.matrix);
  const mirrored = placement.mirrored !== mirrors;
  return placement.kind === 'piece'
    ? { kind: 'piece', pieceId: placement.pieceId, matrix: composed, mirrored }
    : { kind: 'mesh', geometry: placement.geometry, matrix: composed, mirrored };
}

function geometryOfPiece(id: string): BufferGeometry {
  const piece = pieceById(id);
  if (piece === undefined) throw new Error(`program odkazuje na kus ${id}, který v kitu není`);
  return piece.build();
}

function placeNode(
  node: GeomNode,
  built: readonly (readonly GeomPlacement[])[],
): readonly GeomPlacement[] {
  switch (node.kind) {
    case 'terrain':
      return [
        {
          kind: 'mesh',
          geometry: terrainGeometry(node),
          matrix: placementMatrix(node.at, rotationOf(node), undefined),
          mirrored: false,
        },
      ];

    case 'group':
      return node.children.flatMap((child) => built[child]);

    case 'repeat': {
      const [dx, dy, dz] = node.step;
      return Array.from({ length: node.count }, (_unused, step) => {
        const offset = new Matrix4().makeTranslation(dx * step, dy * step, dz * step);
        return built[node.child].map((placement) => transformed(placement, offset));
      }).flat();
    }

    case 'mirror': {
      const about = node.about ?? 0;
      const reflection =
        node.axis === 'x'
          ? new Matrix4().makeTranslation(2 * about, 0, 0).multiply(new Matrix4().makeScale(-1, 1, 1))
          : new Matrix4().makeTranslation(0, 0, 2 * about).multiply(new Matrix4().makeScale(1, 1, -1));
      return [
        ...built[node.child],
        ...built[node.child].map((placement) => transformed(placement, reflection, true)),
      ];
    }

    case 'carve':
      return [
        {
          kind: 'mesh',
          geometry: carve(bakePlacements(built[node.child]), node.at, node.size),
          matrix: new Matrix4(),
          mirrored: false,
        },
      ];

    case 'scatter': {
      const stream = xoroshiro128plus(node.seed);
      return Array.from({ length: node.count }, () => {
        // Tytéž tři losy v tomtéž pořadí jako ve slučující cestě — jinak by
        // táž věta dala jiný svět podle toho, kdo ji zrovna staví.
        const angle = (uniformInt(stream, 0, 3599) / 3600) * Math.PI * 2;
        const distance = node.radius * Math.sqrt(uniformInt(stream, 0, 1000) / 1000);
        const yaw = uniformInt(stream, 0, 3);
        const matrix = placementMatrix(
          [Math.cos(angle) * distance, 0, Math.sin(angle) * distance],
          { yaw },
          undefined,
        );
        return built[node.child].map((placement) => transformed(placement, matrix));
      }).flat();
    }

    case 'arrayAlongCurve':
      return curveOffsets(node.points, node.count).flatMap((offset) => {
        const matrix = new Matrix4().makeTranslation(offset.x, offset.y, offset.z);
        return built[node.child].map((placement) => transformed(placement, matrix));
      });

    case 'anchorTo': {
      // Kvádr se bere z **upečeného** cíle, ne ze součtu kvádrů jednotlivých
      // kusů. Je to dražší o jedno slepení, ale je to jediný způsob, jak dát
      // touž kotvu jako slučující cesta: obalový kvádr otočeného kusu je menší
      // než otočený obalový kvádr, a od P13 vlny 1 se otáčí volně, takže by se
      // ty dvě čísla u každého programu s `pitch` nebo `roll` rozešla.
      const baked = bakePlacements(built[node.target]);
      const matrix = anchorTranslation(boundsOfGeometry(baked), node.site, node.offset);
      baked.dispose();
      return built[node.child].map((placement) => transformed(placement, matrix));
    }

    default: {
      const id = pieceIdOf(node.kind, node.variant);
      if (pieceById(id) === undefined)
        throw new Error(`program odkazuje na kus ${id}, který v kitu není`);
      return [
        {
          kind: 'piece',
          pieceId: id,
          matrix: placementMatrix(node.at, rotationOf(node), node.scale),
          mirrored: false,
        },
      ];
    }
  }
}

/** Plán → jedna síť. Orákulum shody se slučující cestou a záloha pro `carve`. */
export function bakePlacements(placements: readonly GeomPlacement[]): BufferGeometry {
  return concat(
    placements.map((placement) => {
      const geometry =
        placement.kind === 'piece'
          ? geometryOfPiece(placement.pieceId)
          : placement.geometry.clone();
      geometry.applyMatrix4(placement.matrix);
      if (placement.mirrored) flipWinding(geometry);
      return geometry;
    }),
  );
}

/**
 * Program → plán rozmístění.
 *
 * Průchod odspodu nahoru jako u slučující cesty: potomek má vždy nižší index
 * než rodič, což vynutil `parseGeomProgram`, takže se nikde nerekurzuje.
 */
export function compilePlacements(input: GeomProgram | unknown): readonly GeomPlacement[] {
  const program = parseGeomProgram(input);

  const built: (readonly GeomPlacement[])[] = [];
  program.nodes.forEach((node, index) => {
    built[index] = placeNode(node, built);
  });
  const root = built[program.root];

  // Zem a prosekané podstromy, které v kořeni neskončily, se uvolní — jinak by
  // v prohlížeči po každém přeložení věty zůstaly viset buffery.
  const kept = new Set(
    root.filter((placement) => placement.kind === 'mesh').map((placement) => placement.geometry),
  );
  const created = new Set(
    built.flatMap((placements) =>
      placements
        .filter((placement) => placement.kind === 'mesh')
        .map((placement) => placement.geometry),
    ),
  );
  created.forEach((geometry) => {
    if (!kept.has(geometry)) geometry.dispose();
  });

  if (
    root.every(
      (placement) => placement.kind === 'mesh' && trianglesOfGeometry(placement.geometry) === 0,
    )
  ) {
    kept.forEach((geometry) => geometry.dispose());
    throw new Error('program compiled to an empty geometry: nothing is left after the carves');
  }

  return root;
}
