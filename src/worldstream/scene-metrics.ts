import { overlaps, placedBoxes, unsupported } from '../geom/contact';
import { compilePlacements, type GeomPlacement } from '../geom/placements';
import { parseGeomProgram, reachableFrom } from '../geom/program';
import type { PlannedObject } from '../model/worldstream-intent';

import type { WorldstreamBlueprint } from './schema';

/**
 * **Strojový report scény — report, ne brána.** Čísla se zapisují a čtou,
 * žádná mez tu nikoho neodmítá.
 *
 * „Medián 3 objekty" z P18 počítal deklarované objekty a znělo to jako počet
 * věcí ve scéně. Tady se proto kusy počítají **po rozvinutí** `repeat`,
 * `scatter` a dalších násobičů: šest desek z jedné řady je šest kusů, které
 * kamera uvidí, ne jeden objekt.
 */
export interface SceneMetrics {
  /** Umístěné kusy kitu po rozvinutí plus hrdinské tvary. */
  readonly visiblePieces: number;
  /** Kusy kitu, které nic nedrží (`src/geom/contact.ts`). */
  readonly unsupportedPieces: number;
  /** Dvojice kusů kitu, které se prolínají. */
  readonly collisions: number;
  /** Podíl objektů z plánu, které ve scéně doopravdy vznikly. Efekty se nepočítají. */
  readonly nounCoverage: number;
  /** Popisky objektů z plánu, které ve scéně nevznikly. */
  readonly missing: readonly string[];
}

export function sceneMetrics(
  blueprint: Pick<WorldstreamBlueprint, 'geometry' | 'objects' | 'shapes'>,
  planned: readonly PlannedObject[],
): SceneMetrics {
  const placements = compilePlacements(blueprint.geometry);
  const pieces = placements.filter((placement) => placement.kind === 'piece');
  const boxes = placedBoxes(pieces);
  release(placements);

  // Objekt z geometrie vznikl, když aspoň jeden kus scény pochází z jeho
  // podstromu. Razítko `owner` dostává jen nejbližší vlastník, takže objekt
  // složený jen z jiných objektů by sám žádné neměl — razítkuje se proto celý
  // jeho podstrom.
  const program = parseGeomProgram(blueprint.geometry);
  const geomBuilt = (node: number): boolean => {
    const stamped = compilePlacements(program, reachableFrom(program.nodes, node));
    release(stamped);
    return stamped.some((placement) => placement.owner !== undefined);
  };
  const shapeIds = new Set(blueprint.shapes.map((shape) => shape.shapeId));
  const built = (stableId: string): boolean => {
    const object = blueprint.objects.find((candidate) => candidate.stableId === stableId);
    if (object === undefined) return false;
    return object.source.kind === 'geom' ? geomBuilt(object.source.node) : shapeIds.has(object.source.shapeId);
  };

  const counted = planned.filter((object) => object.role !== 'effect');
  const missing = counted.filter((object) => !built(object.stableId)).map((object) => object.label);

  return {
    visiblePieces: pieces.length + blueprint.shapes.length,
    unsupportedPieces: unsupported(boxes).length,
    collisions: overlaps(boxes).length,
    nounCoverage: counted.length === 0 ? 1 : (counted.length - missing.length) / counted.length,
    missing,
  };
}

function release(placements: readonly GeomPlacement[]): void {
  placements.forEach((placement) => {
    if (placement.kind === 'mesh') placement.geometry.dispose();
  });
}
