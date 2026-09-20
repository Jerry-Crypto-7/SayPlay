import { Box3, type BufferGeometry } from 'three';

import { pieceById } from '../kit';
import type { GeomPlacement } from './placements';

/**
 * Dotyk, průnik a hranice **rozvinuté** scény — nad `GeomPlacement[]`
 * z `compilePlacements()`, ne nad deklarovaným `targetBounds`.
 *
 * Deklarovaný kvádr kompozice z kitu vědomě ignoruje (`src/worldstream/slots.ts`),
 * takže jediná poctivá otázka „visí ta deska?" se klade nad tím, kde kus
 * doopravdy skončil. Kus se tu zjednodušuje na opsaný kvádr ve světových
 * souřadnicích; jednotka je metr.
 *
 * Podpora je převzatá ze SceneEval: kontakt do 1 cm a těžiště promítnuté ve
 * směru gravitace uvnitř konvexního obalu kontaktních ploch. Tolerance je
 * práh, který rozhoduje — příliš velká tiše prohlásí visící desku za stojící.
 */

/** Kontakt i průnik se soudí s tolerancí jednoho centimetru. */
export const CONTACT_TOLERANCE = 0.01;

export interface PlacedBox {
  /** Index v plánu rozmístění, ze kterého kvádr vznikl. */
  readonly index: number;
  readonly kind: GeomPlacement['kind'];
  /** `pieceId` u kusu kitu, `null` u sítě (zem, tažený profil, řez). */
  readonly pieceId: string | null;
  readonly box: Box3;
}

const localBoxes = new Map<string, Box3>();

function pieceBox(pieceId: string): Box3 {
  const cached = localBoxes.get(pieceId);
  if (cached !== undefined) return cached;
  const piece = pieceById(pieceId);
  if (piece === undefined) throw new Error(`unknown kit piece ${pieceId}`);
  const geometry = piece.build();
  const box = geometryBox(geometry);
  geometry.dispose();
  localBoxes.set(pieceId, box);
  return box;
}

function geometryBox(geometry: BufferGeometry): Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox?.clone() ?? new Box3();
}

/** Opsané kvádry všech umístění ve světových souřadnicích. */
export function placedBoxes(placements: readonly GeomPlacement[]): readonly PlacedBox[] {
  return placements.map((placement, index) => {
    const local = placement.kind === 'piece' ? pieceBox(placement.pieceId) : geometryBox(placement.geometry);
    return {
      index,
      kind: placement.kind,
      pieceId: placement.kind === 'piece' ? placement.pieceId : null,
      box: local.clone().applyMatrix4(placement.matrix),
    };
  });
}

type Point = readonly [number, number];

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Konvexní obal v rovině XZ (monotone chain), proti směru hodinových ručiček. */
function convexHull(points: readonly Point[]): readonly Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function insideHull(hull: readonly Point[], point: Point): boolean {
  if (hull.length === 0) return false;
  if (hull.length < 3) {
    // Obal zdegeneroval na bod nebo úsečku: těžiště musí ležet na ní.
    const [a, b = a] = hull;
    const within = (value: number, x: number, y: number) =>
      value >= Math.min(x, y) - CONTACT_TOLERANCE && value <= Math.max(x, y) + CONTACT_TOLERANCE;
    return Math.abs(cross(a, b, point)) <= CONTACT_TOLERANCE && within(point[0], a[0], b[0]) && within(point[1], a[1], b[1]);
  }
  return hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], point) >= -CONTACT_TOLERANCE);
}

/**
 * Je kus podepřený? Ano, když jeho spodek leží do 1 cm nad podlahou
 * (`floorY`), nebo na horní ploše jiného kusu, se kterým se v půdorysu
 * překrývá — a těžiště (střed kvádru) padá do obalu těch kontaktních ploch.
 */
export function isSupported(boxes: readonly PlacedBox[], index: number, floorY = 0): boolean {
  const own = boxes[index].box;
  if (Math.abs(own.min.y - floorY) <= CONTACT_TOLERANCE) return true;
  const corners: Point[] = [];
  for (const other of boxes) {
    if (other.index === index) continue;
    const top = other.box;
    if (Math.abs(top.max.y - own.min.y) > CONTACT_TOLERANCE) continue;
    const minX = Math.max(own.min.x, top.min.x);
    const maxX = Math.min(own.max.x, top.max.x);
    const minZ = Math.max(own.min.z, top.min.z);
    const maxZ = Math.min(own.max.z, top.max.z);
    if (minX > maxX || minZ > maxZ) continue;
    corners.push([minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]);
  }
  const centre: Point = [(own.min.x + own.max.x) / 2, (own.min.z + own.max.z) / 2];
  return insideHull(convexHull(corners), centre);
}

/** Indexy kusů, které nic nedrží. */
export function unsupported(boxes: readonly PlacedBox[], floorY = 0): readonly number[] {
  return boxes.filter((entry) => !isSupported(boxes, entry.index, floorY)).map((entry) => entry.index);
}

/**
 * Dvojice kusů, které se prolínají o víc než 1 cm ve všech třech osách.
 * Kus položený na jiném se jen dotýká a průnik nehlásí.
 */
export function overlaps(boxes: readonly PlacedBox[]): readonly (readonly [number, number])[] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i].box;
      const b = boxes[j].box;
      const depth = Math.min(
        Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x),
        Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y),
        Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z),
      );
      if (depth > CONTACT_TOLERANCE) pairs.push([boxes[i].index, boxes[j].index]);
    }
  }
  return pairs;
}

/** Indexy kusů, které přesahují hranici světa o víc než 1 cm. */
export function outOfBounds(boxes: readonly PlacedBox[], world: Box3): readonly number[] {
  const allowed = world.clone().expandByScalar(CONTACT_TOLERANCE);
  return boxes.filter((entry) => !allowed.containsBox(entry.box)).map((entry) => entry.index);
}
