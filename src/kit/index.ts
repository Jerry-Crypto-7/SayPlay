import { Group, Mesh, MeshToonMaterial } from 'three';

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
