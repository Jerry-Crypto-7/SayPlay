import { Box3, Group, Mesh, MeshToonMaterial, Vector3 } from 'three';

import { LAYOUTS, type Layout } from './layouts';
import { PALETTES, repaint } from './palettes';
import { actorPieces } from './pieces/actor';
import { archPieces } from './pieces/arch';
import { columnPieces } from './pieces/column';
import { fixturePieces } from './pieces/fixture';
import { massPieces } from './pieces/mass';
import { organicPieces } from './pieces/organic';
import { panelPieces } from './pieces/panel';

export {
  SWATCHES,
  srgbHexToLinear,
  type Piece,
  type PieceCategory,
  type SwatchName,
} from './pieces/primitives';
export { KIT_BUDGETS, measureScene, trianglesOf, type SceneMeasurement } from './budgets';
export {
  LAYOUTS,
  footprintSignature,
  layoutById,
  type Layout,
  type Placement,
} from './layouts';
export { PALETTES, repaint, type Palette, type PaletteName } from './palettes';

/** Jediný index kitu. Nic jiného než tenhle soubor kusy nevydává. */
export const KIT = [
  ...massPieces,
  ...columnPieces,
  ...archPieces,
  ...panelPieces,
  ...fixturePieces,
  ...organicPieces,
  ...actorPieces,
] as const;

export function pieceById(id: string) {
  return KIT.find((piece) => piece.id === id);
}

/**
 * Jeden materiál na celý kit — proto je draw call totéž co umístěný kus.
 *
 * `MeshToonMaterial` **nemá `flatShading`** (past z `CLAUDE.md`), takže ploché
 * stínování nese geometrie: normály jsou zapečené v `assemble()`. Kdyby se
 * materiál někdy vyměnil za `MeshStandardMaterial`, vzhled se nezmění — a to
 * je záměr.
 */
export function kitMaterial(): MeshToonMaterial {
  return new MeshToonMaterial({ vertexColors: true });
}

/**
 * Scéna se všemi kusy najednou, po jednom od každého. Je to nejhorší případ
 * pro rozpočet z `budgets.ts` a zároveň nejlevnější způsob, jak se na kit
 * podívat celý.
 */
export function buildKitScene(): Group {
  const group = new Group();
  const material = kitMaterial();
  const columns = 8;

  KIT.forEach((piece, index) => {
    const mesh = new Mesh(piece.build(), material);
    mesh.position.set((index % columns) * 2 - columns, 0, Math.floor(index / columns) * 2);
    mesh.name = piece.id;
    group.add(mesh);
  });

  return group;
}

/**
 * Postaví ručně skládaný layout — kusy z kitu, přebarvené paletou layoutu.
 *
 * Všechno je hotové **synchronně a bez jediného síťového požadavku**: kusy se
 * generují kódem, layout je JSON zapečený v bundlu. To je celý důvod, proč kit
 * zvládne první snímek bez loading screenu.
 */
export function buildLayoutScene(layout: Layout): Group {
  const group = new Group();
  const material = kitMaterial();
  const palette = PALETTES[layout.palette];

  for (const placement of layout.placements) {
    const piece = pieceById(placement.piece);
    if (piece === undefined) {
      throw new Error(`layout ${layout.id} odkazuje na neznámý kus ${placement.piece}`);
    }

    const geometry = piece.build();
    repaint(geometry, palette);
    geometry.computeBoundingBox();

    const mesh = new Mesh(geometry, material);
    const [cellX, cellZ] = placement.cell;
    const [offsetX, offsetZ] = placement.offset ?? [0, 0];
    // Otáčí se kolem osy Y, takže spodek kusu zůstane tam, kde byl.
    mesh.rotation.y = (placement.yaw ?? 0) * (Math.PI / 2);
    mesh.position.set(
      cellX + offsetX,
      (placement.level ?? 0) - geometry.boundingBox!.min.y,
      cellZ + offsetZ,
    );
    mesh.name = `${placement.piece}@${cellX},${cellZ}`;
    group.add(mesh);
  }

  // Vycentrovat vodorovně, výšku nechat být — kusy stojí na zemi.
  const center = new Box3().setFromObject(group).getCenter(new Vector3());
  group.position.set(-center.x, 0, -center.z);
  return group;
}

export function defaultLayout(): Layout {
  return LAYOUTS[0];
}
