import { Box3, Vector3 } from 'three';

import { isSupported, overlaps, placedBoxes, unsupported, type PlacedBox } from '../geom/contact';
import { compilePlacements, type GeomPlacement } from '../geom/placements';
import { parseGeomProgram, reachableFrom } from '../geom/program';
import type { PlannedObject } from '../model/worldstream-intent';

import type { WorldstreamBlueprint } from './schema';
import {WORLDSTREAM_ASSETS} from '../assets/catalog';
import type {AssetManifest} from '../assets/manifest';

export interface RepresentationEvidence {
  readonly stableId:string;
  readonly label:string;
  readonly source:'geom'|'shape'|'asset'|'absent';
  readonly declared:boolean;
  readonly geometryBuilt:boolean|null;
  readonly catalogResolved:boolean|null;
  readonly loaded:'unobserved';
  readonly reason:string|null;
  /**
   * **Kontakt, kolize a počty pro každou reprezentaci** (P20 A3).
   *
   * Do 17. 9. 2026 to uměl jen součet za celou scénu, a ten se počítal
   * výhradně nad kvádry kitu — objekt z assetu nebo z tvaru v něm nebyl vůbec,
   * takže „0 kolizí" mohlo znamenat „nic se neprolíná" i „nic se nepočítalo".
   *
   * `instances` je počet kusů **po rozvinutí** `repeat`/`scatter`: řada šesti
   * desek je šest kusů, které kamera uvidí. Tvar a asset mají jeden kvádr —
   * svůj `targetBounds`, protože jemnější tvar tahle metrika nezná a
   * předstírat ho by bylo horší než ho přiznat.
   *
   * `unsupported` počítá kusy, pod kterými po usazení nic není, `collisions`
   * dvojice s **cizím** objektem. Prolnutí dvou kusů téhož objektu není vada:
   * sloupek zapuštěný do své desky je návrh, ne chyba.
   */
  readonly instances:number;
  readonly unsupported:number;
  readonly collisions:number;
}

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
  /** Kusy kitu, které nic nedrží ani po usazení (`src/geom/contact.ts`, `settle.ts`). */
  readonly unsupportedPieces: number;
  /** Dvojice kusů kitu, které se prolínají. */
  readonly collisions: number;
  /** Podíl objektů z plánu, které ve scéně doopravdy vznikly. Efekty se nepočítají. */
  readonly nounCoverage: number|null;
  /** Popisky objektů z plánu, které ve scéně nevznikly. */
  readonly missing: readonly string[];
  /** Assets require browser observations; references never count as built geometry. */
  readonly unknown:readonly string[];
  readonly representationEvidence:readonly RepresentationEvidence[];
  readonly metricScope:'legacy-geom-shape'|'hybrid-partial';
  readonly nounCoverageBounds:{readonly lower:number;readonly upper:number};
}

export function sceneMetrics(
  blueprint: Pick<WorldstreamBlueprint, 'geometry' | 'objects' | 'shapes'>,
  planned: readonly PlannedObject[],
  assets:AssetManifest=WORLDSTREAM_ASSETS,
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
    // A catalog reference alone does not prove a rendered/recognizable object.
    return object.source.kind === 'geom' ? geomBuilt(object.source.node)
      : object.source.kind === 'shape' && shapeIds.has(object.source.shapeId);
  };

  const counted = planned.filter((object) => object.role !== 'effect');
  const contact = contactByObject(blueprint, program);
  const representationEvidence:RepresentationEvidence[]=counted.map(plan=>{
    const object=blueprint.objects.find(candidate=>candidate.stableId===plan.stableId);
    const resolution=object?.source.kind==='asset'?assets.resolve(object.source):null;
    return {stableId:plan.stableId,label:plan.label,source:object?.source.kind??'absent',declared:!!object,
      geometryBuilt:object?.source.kind==='asset'?null:built(plan.stableId),catalogResolved:resolution?.ok??null,
      loaded:'unobserved',reason:resolution&&!resolution.ok?resolution.reason:null,
      ...(contact.get(plan.stableId)??{instances:0,unsupported:0,collisions:0})};
  });
  const unknown=representationEvidence.filter(item=>item.source==='asset'&&item.catalogResolved).map(item=>item.label);
  const missing=representationEvidence.filter(item=>item.source==='asset'?!item.catalogResolved:!item.geometryBuilt).map(item=>item.label);
  const hybrid=blueprint.objects.some(object=>object.source.kind==='asset');
  const knownBuilt=representationEvidence.filter(item=>item.geometryBuilt).length;
  const ratio=(value:number)=>counted.length===0?1:value/counted.length;

  return {
    visiblePieces: pieces.length + blueprint.shapes.length,
    unsupportedPieces: unsupported(boxes).length,
    collisions: overlaps(boxes).length,
    nounCoverage: hybrid?null:ratio(knownBuilt),
    missing,
    unknown,representationEvidence,metricScope:hybrid?'hybrid-partial':'legacy-geom-shape',
    nounCoverageBounds:{lower:ratio(knownBuilt),upper:ratio(knownBuilt+unknown.length)},
  };
}

/**
 * Kontakt, kolize a počty **na jeden objekt**.
 *
 * Kvádry se skládají ze dvou zdrojů a záměrně **mimo** `boxes` výš: scénové
 * součty `unsupportedPieces` a `collisions` počítají kusy kitu a tři dokumenty
 * na ta čísla odkazují, takže se sem nesmí přimíchat kvádr assetu a hnout jimi.
 *
 * - objekt z geometrie dostane všechna umístění, jejichž `owner` je jeho uzel
 *   (razítko se přenáší i na kopie z `repeat`/`scatter`, takže řada šesti
 *   desek je šest kusů);
 * - objekt z tvaru nebo z assetu dostane jeden kvádr, svůj `targetBounds`.
 *
 * Kolize se počítají jen s **cizím** objektem: dva kusy téhož objektu se smějí
 * prolínat, protože to je jeho vlastní stavba.
 */
function contactByObject(
  blueprint: Pick<WorldstreamBlueprint, 'geometry' | 'objects' | 'shapes'>,
  program: ReturnType<typeof parseGeomProgram>,
): Map<string, { instances: number; unsupported: number; collisions: number }> {
  const owners = new Map<number, string>();
  for (const object of blueprint.objects)
    if (object.source.kind === 'geom') owners.set(object.source.node, object.stableId);

  const boxes: PlacedBox[] = [];
  const ownerOf: string[] = [];
  const push = (box: PlacedBox['box'], stableId: string) => {
    boxes.push({ index: boxes.length, kind: 'mesh', pieceId: null, box });
    ownerOf.push(stableId);
  };

  const stamped = compilePlacements(program, new Set(owners.keys()));
  for (const [index, placed] of placedBoxes(stamped).entries()) {
    const owner = stamped[index].owner;
    if (owner !== undefined && owners.has(owner)) push(placed.box, owners.get(owner)!);
  }
  release(stamped);
  for (const object of blueprint.objects)
    if (object.source.kind !== 'geom')
      push(
        new Box3(new Vector3(...object.targetBounds.min), new Vector3(...object.targetBounds.max)),
        object.stableId,
      );

  const result = new Map<string, { instances: number; unsupported: number; collisions: number }>();
  for (const stableId of new Set(ownerOf)) result.set(stableId, { instances: 0, unsupported: 0, collisions: 0 });
  for (const box of boxes) {
    const entry = result.get(ownerOf[box.index])!;
    entry.instances++;
    if (!isSupported(boxes, box.index)) entry.unsupported++;
  }
  for (const [a, b] of overlaps(boxes)) {
    if (ownerOf[a] === ownerOf[b]) continue;
    result.get(ownerOf[a])!.collisions++;
    result.get(ownerOf[b])!.collisions++;
  }
  return result;
}

function release(placements: readonly GeomPlacement[]): void {
  placements.forEach((placement) => {
    if (placement.kind === 'mesh') placement.geometry.dispose();
  });
}
