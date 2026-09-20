/**
 * Podoba entity: asset z katalogu, nebo kus rodiny (P23-A, T8).
 *
 * Katalog (`WORLDSTREAM_ASSETS`, 30 kusů) se ptá týmž `representationCandidates`
 * jako planner – skóre je počet tagů assetu ve slovech `label`u, takže `stone
 * portal` dá `iron-gate` a `party table` `dining-table`. Bez shody dostane
 * entita vlastní řádek v programu geometrie: kus podle druhu role, postavený
 * na buňce entity. Vazba je v obou případech nejjednodušší platná
 * (`assetObjectIssues`): `entityId` + kolizní kvádr, žádné sokety ani díly.
 */

import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import { representationCandidates } from '@/assets/resolver';
import type { GeomNode } from '@/geom/program';
import type { SemanticObject } from '@/worldstream/schema';

import type { RoleKind } from '../spec';

/** Kvádr tak, jak ho čte schéma blueprintu (měnitelné trojice, ne `Bounds3`). */
export type WorldBounds = SemanticObject['targetBounds'];
/** Tvarový uzel kitu – bez terénu a operací, které `scale` nenesou. */
type PieceNode = Extract<GeomNode, { kind: 'mass' | 'column' | 'arch' | 'panel' | 'organic' | 'fixture' | 'actor' }>;

/** Kus kitu na entitu bez assetu; ploché role (zóny) dostanou podlahový panel. */
const PIECE_BY_KIND: Readonly<Record<RoleKind, PieceNode>> = {
  player: { kind: 'actor', variant: 'tall' },
  chaser: { kind: 'actor', variant: 'drone' },
  patrol: { kind: 'actor', variant: 'quadruped' },
  target: { kind: 'actor', variant: 'squat' },
  collectible: { kind: 'organic', variant: 'pebble' },
  key: { kind: 'fixture', variant: 'lamp' },
  item: { kind: 'fixture', variant: 'crate' },
  prop: { kind: 'fixture', variant: 'barrel' },
  switch: { kind: 'fixture', variant: 'terminal' },
  door: { kind: 'arch', variant: 'doorway' },
  exit: { kind: 'arch', variant: 'portal' },
  destination: { kind: 'panel', variant: 'floor' },
  checkpoint: { kind: 'column', variant: 'post' },
  hazard: { kind: 'panel', variant: 'floor' },
  zone: { kind: 'panel', variant: 'floor' },
};

/** Výška podoby ve světových jednotkách; zóny leží na zemi. */
export const HEIGHT_BY_KIND: Readonly<Record<RoleKind, number>> = {
  player: 1.6,
  chaser: 1.2,
  patrol: 1.6,
  target: 1,
  collectible: 0.6,
  key: 0.5,
  item: 0.6,
  prop: 0.8,
  switch: 1,
  door: 2.2,
  exit: 2.4,
  destination: 0.2,
  checkpoint: 1.4,
  hazard: 0.2,
  zone: 0.2,
};

export function assetSource(stableId: string, label: string): SemanticObject['source'] | null {
  const found = representationCandidates({ stableId, label, synonyms: [], role: 'prop', importance: 1 }, WORLDSTREAM_ASSETS);
  return found.candidates[0]?.source ?? null;
}

/** Řádek programu pro entitu bez assetu, postavený na dně jejího kvádru. */
export function pieceNode(kind: RoleKind, bounds: WorldBounds): GeomNode {
  const [x, y, z] = bounds.min;
  const width = bounds.max[0] - x;
  const height = bounds.max[1] - y;
  const depth = bounds.max[2] - z;
  return {
    ...PIECE_BY_KIND[kind],
    at: [x + width / 2, y, z + depth / 2],
    scale: [Math.max(0.1, width), Math.max(0.1, height), Math.max(0.1, depth)],
  };
}
