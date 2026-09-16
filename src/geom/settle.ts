import { Box3, Matrix4, Vector3 } from 'three';

import { CONTACT_TOLERANCE, isSupported, placedBoxes, type PlacedBox } from './contact';
import type { GeomPlacement } from './placements';

/**
 * **Usazení nad rozvinutou geometrií:** kus, který nic nedrží, spadne svisle
 * na nejbližší plochu pod sebou — desku stolu, když pod ním stůl je, jinak na
 * podlahu (`y = 0`).
 *
 * Co má být nahoře, se pozná z **druhu kusu, ne z výšky**: okno, střecha,
 * zábradlí balkonu, podlahová deska (strop, balkon) a průčelí zůstávají, kde
 * je model postavil. Usadit okno na podlahu je horší vada než visící okno a na
 * snímku vypadá jako záměr.
 *
 * Síť (zem, tažený profil, řez) se nikdy nehýbe. Rovná síť (výška do 2 cm)
 * slouží jako podlaha; nad **nerovnou** zemí se kus nechává být, protože
 * z opsaného kvádru výškového pole se výška pod kusem vyčíst nedá a usazení
 * na nejnižší bod by ho zabořilo.
 */

/** Kusy, které patří nahoru. */
export const STAYS_UP: ReadonlySet<string> = new Set([
  'panel.window',
  'panel.roof',
  'panel.railing',
  'panel.floor',
  'panel.facade',
]);

const FLAT_MESH = 0.02;

function overlapsFootprint(a: Box3, b: Box3): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.z < b.max.z && a.max.z > b.min.z;
}

function holdsCentre(surface: Box3, own: Box3): boolean {
  const x = (own.min.x + own.max.x) / 2;
  const z = (own.min.z + own.max.z) / 2;
  return x >= surface.min.x && x <= surface.max.x && z >= surface.min.z && z <= surface.max.z;
}

/** O kolik kus klesne, nebo `null`, když se nechává být. */
function dropOf(boxes: readonly PlacedBox[], entry: PlacedBox, floorY: number): number | null {
  const own = entry.box;
  let surface = own.min.y > floorY + CONTACT_TOLERANCE ? floorY : null;
  for (const other of boxes) {
    if (other.index === entry.index || !overlapsFootprint(own, other.box)) continue;
    const top = other.box.max.y;
    if (other.kind === 'mesh' && top - other.box.min.y > FLAT_MESH) return null;
    if (top > own.min.y + CONTACT_TOLERANCE || !holdsCentre(other.box, own)) continue;
    if (surface === null || top > surface) surface = top;
  }
  if (surface === null) return null;
  const drop = own.min.y - surface;
  return drop > CONTACT_TOLERANCE ? drop : null;
}

export function settlePlacements(
  placements: readonly GeomPlacement[],
  floorY = 0,
): readonly GeomPlacement[] {
  const boxes = placedBoxes(placements);
  const settled = [...placements];

  // Odspodu nahoru: věc na stole se usazuje až nad usazeným stolem.
  const order = [...boxes].sort((a, b) => a.box.min.y - b.box.min.y);
  for (const entry of order) {
    if (entry.kind !== 'piece' || entry.pieceId === null || STAYS_UP.has(entry.pieceId)) continue;
    if (isSupported(boxes, entry.index, floorY)) continue;
    const drop = dropOf(boxes, entry, floorY);
    if (drop === null) continue;
    entry.box.translate(new Vector3(0, -drop, 0));
    const placement = settled[entry.index];
    settled[entry.index] = {
      ...placement,
      matrix: new Matrix4().makeTranslation(0, -drop, 0).multiply(placement.matrix),
    };
  }
  return settled;
}
