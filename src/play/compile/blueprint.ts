/**
 * `WorldstreamBlueprint` kolem zkompilovaného světa (P23-A, T8).
 *
 * Obálka je táž, kterou emituje modelový kompilátor, jen skládaná z hotových
 * kusů: `world` = povrchový `sim` zapečetěný `sealSimHash` + `look` z tématu,
 * `geometry` = program rodiny (`family.compose(seed)`) rozšířený o jeden řádek
 * na každou entitu bez assetu, `objects` = právě jeden objekt na entitu s
 * vazbou `binding.entityId`, takže jeviště hýbe podobou tam, kam runtime
 * posune entitu. `intent` se čte z tématu, cíle a vysvětlení mechanik.
 *
 * Řádky entit se věší pod nový kořen `group` (nejvýš 16 potomků, proto po
 * šestnácti do podskupin); rodina má do 17 řádků, `clearArena` přidá 4 a spec
 * do 64 entit, strop `GEOM_LIMITS.maxNodes = 96` tedy drží i v nejhorším
 * případě (17 + 4 + 64 + 5).
 */

import { cellToWorld } from '@/components/viewer/projection';
import type { GeomNode, GeomProgram } from '@/geom/program';
import { WORLD_DOC_VERSION, type WorldDoc, sealSimHash } from '@/ir/worlddoc';
import type { IntentSummary } from '@/model/worldstream-intent';
import { BLUEPRINT_VERSION_V2, type SemanticObject, type WorldstreamBlueprint } from '@/worldstream/schema';

import { MECHANICS } from '../registry';
import type { GameRole, GameSpecV1 } from '../spec';
import { HEIGHT_BY_KIND, type WorldBounds, assetSource, pieceNode } from './assets';
import type { Layout, Rect } from './layout';
import { buildLook } from './look';
import type { SimCompilation } from './types';

/** Kolik z buňky podoba zabere – mezera mezi sousedy, ať se kusy nedotýkají. */
const CELL_FILL = 0.9;
const GROUP_CHILDREN = 16;
/**
 * Kolik metrů kolem hrací plochy se z kulis vyřízne. Rodiny jsou celé scény
 * (terasy, věže) a stavěly přímo na plochu, takže rytíř a klíče stáli uvnitř
 * zdí (QA 22. 9. 2026). Řez bere trojúhelníky podle těžiště, velké stěny
 * rodin mají těžiště daleko – proto rezerva, ne těsný obrys.
 */
const ARENA_MARGIN = 4;
/**
 * Na straně kamery se řeže až k ní: výchozí pohled přichází od +x/+z
 * (`DEFAULT_AZIMUTH` ve `framing.ts`) ze vzdálenosti přes 13 m, a zeď rodiny
 * v té dráze zakryla celou hru. Za hrou kulisy zůstávají jako pozadí.
 */
const CAMERA_SIDE_MARGIN = 20;
const ARENA_CEILING = 40;
/**
 * Řez začíná hluboko pod podlahou. Terén rodiny je strmý (amplituda až 3,4 m)
 * a řez soudí podle těžiště: při −0,05 zůstaly trojúhelníky s těžištěm těsně
 * pod nulou, jejichž vrcholy prorážely podlahu jako šedé střepy.
 */
const CARVE_FLOOR = -1.5;
/**
 * Jak daleko od středu sahá rodina na ose x nebo z, změřeno 25. 9. 2026
 * (`scenery-carve.test.ts`) a zaokrouhleno nahoru.
 *
 * Řez bere trojúhelníky podle těžiště, takže velké stěny a strmý terén rodiny,
 * které zasáhl, zůstaly jako zubaté šedé střepy přes pozadí (F-28). Rodina
 * proto stojí úhlopříčně za plochou (kamera přichází od +x/+z) tak daleko, že
 * ji řez nezasáhne vůbec. Řez zůstává: slévá rodinu do jednoho kusu, jinak by
 * každý strom byl vlastní draw call.
 */
export const FAMILY_REACH: Readonly<Record<string, number>> = { terraces: 25.5, spires: 12.5, grove: 11.5, works: 19 };
/** Rodina se zvedne nad rovnou zem, ať se její plochý terén s tou pod plochou nepere. */
const FAMILY_LIFT = 0.03;
/** Nejdelší strana terénu, kterou schéma geometrie přijme. */
const TERRAIN_SPAN = 64;

/** Kulisy stranou hrací plochy a pod ní rovný terén až k nim. */
function clearArena(base: GeomProgram, layout: Layout, familyId: string): GeomProgram {
  const width = layout.width + ARENA_MARGIN * 2;
  const depth = layout.height + ARENA_MARGIN * 2;
  const shift = (CAMERA_SIDE_MARGIN - ARENA_MARGIN) / 2;
  // Stačí oddělení na jedné ose: na kratší straně plochy, ať kulisa nestojí dál, než musí.
  const away = Math.min(width, depth) / 2 + (FAMILY_REACH[familyId] as number) + 0.5;
  // Zem od kamery (+x/+z) ke středu rodiny; dál ji nese terén rodiny sám.
  const near = (low: number) => Math.min(TERRAIN_SPAN, low / 2 + CAMERA_SIDE_MARGIN + away);
  const ground: [number, number] = [near(layout.width), near(layout.height)];
  const groundAt: [number, number, number] = [layout.width / 2 + CAMERA_SIDE_MARGIN - ground[0] / 2, 0, layout.height / 2 + CAMERA_SIDE_MARGIN - ground[1] / 2];
  const nodes: GeomNode[] = [
    ...base.nodes,
    { kind: 'terrain', variant: 'flat', extent: ground, amplitude: 0, seed: 0, at: groundAt },
  ];
  const floor = nodes.length - 1;
  nodes.push({ kind: 'anchorTo', child: base.root, target: floor, site: 'top', offset: [-away - groundAt[0], FAMILY_LIFT, -away - groundAt[2]] });
  nodes.push({
    kind: 'carve',
    child: nodes.length - 1,
    at: [shift, CARVE_FLOOR + ARENA_CEILING / 2, shift],
    size: [width + shift * 2, ARENA_CEILING, depth + shift * 2],
  });
  nodes.push({ kind: 'group', children: [nodes.length - 1, floor] });
  return { version: base.version, nodes, root: nodes.length - 1 };
}

const ACTOR_KINDS: readonly GameRole['kind'][] = ['player', 'chaser', 'patrol', 'target'];
const HERO_KINDS: readonly GameRole['kind'][] = ['exit', 'destination', 'door'];

/** Kvádr entity ve světových souřadnicích: obdélník zóny, jinak její buňka. */
function entityBounds(rect: Rect, height: number, layout: Layout): WorldBounds {
  const [x, y, w, h] = rect;
  const centre = cellToWorld([x + (w - 1) / 2, y + (h - 1) / 2], layout);
  const halfW = (w - 1 + CELL_FILL) / 2;
  const halfD = (h - 1 + CELL_FILL) / 2;
  return { min: [centre.x - halfW, 0, centre.z - halfD], max: [centre.x + halfW, height, centre.z + halfD] };
}

function importanceOf(kind: GameRole['kind']): SemanticObject['importance'] {
  if (kind === 'player') return 3;
  if (HERO_KINDS.includes(kind)) return 2;
  return 1;
}

function intentOf(spec: GameSpecV1): IntentSummary {
  const labels = (kinds: readonly GameRole['kind'][]): string[] => spec.roles.filter((role) => kinds.includes(role.kind)).map((role) => role.label);
  return {
    setting: spec.theme.setting,
    mood: spec.theme.mood,
    spatialThesis: spec.objective.description,
    actors: labels(ACTOR_KINDS),
    heroObjects: labels(HERO_KINDS),
    interactions: spec.mechanics.map((mechanic) => MECHANICS[mechanic.id].explanation),
    unsupported: [],
  };
}

/** Program rodiny + řádky entit pod jedním kořenem. Vrací i index řádku každé entity. */
function extendGeometry(base: GeomProgram, pieces: readonly { id: string; node: GeomNode }[]): { geometry: GeomProgram; nodeOf: Map<string, number> } {
  const nodes: GeomNode[] = [...base.nodes];
  const nodeOf = new Map<string, number>();
  for (const piece of pieces) {
    nodeOf.set(piece.id, nodes.length);
    nodes.push(piece.node);
  }
  const rootChildren: number[] = [base.root];
  const pieceIndices = [...nodeOf.values()];
  for (let start = 0; start < pieceIndices.length; start += GROUP_CHILDREN) {
    rootChildren.push(nodes.length);
    nodes.push({ kind: 'group', children: pieceIndices.slice(start, start + GROUP_CHILDREN) });
  }
  nodes.push({ kind: 'group', children: rootChildren });
  return { geometry: { version: base.version, nodes, root: nodes.length - 1 }, nodeOf };
}

export function assembleBlueprint(spec: GameSpecV1, seed: number, compilation: SimCompilation): WorldstreamBlueprint {
  const { sim, layout, roles } = compilation;
  const playerRole = spec.roles.find((role) => role.kind === 'player') as GameRole;
  const player = (roles.find((binding) => binding.roleId === playerRole.id)?.entityIds[0] ?? 'player') as string;
  const { look, family } = buildLook(spec, seed, player, Math.max(layout.width, layout.height));

  const roleOfEntity = new Map<string, GameRole>();
  for (const role of spec.roles) for (const id of roles.find((binding) => binding.roleId === role.id)?.entityIds ?? []) roleOfEntity.set(id, role);

  const entries: { base: Omit<SemanticObject, 'source'>; asset: SemanticObject['source'] | null }[] = [];
  const pieces: { id: string; node: GeomNode }[] = [];
  for (const [id, entity] of Object.entries(sim.entities)) {
    const role = roleOfEntity.get(id);
    const kind = role?.kind ?? 'prop';
    const label = role?.label ?? id;
    const cell = sim.sockets[entity.socket] as readonly [number, number];
    const rect: Rect = layout.zones[id] ?? [cell[0], cell[1], 1, 1];
    const targetBounds = entityBounds(rect, HEIGHT_BY_KIND[kind], layout);
    const binding = { entityId: id, collider: targetBounds, sockets: [], parts: [] };
    const base = { stableId: id, label, synonyms: [], role: kind === 'player' ? ('hero' as const) : ('prop' as const), binding, targetBounds, importance: importanceOf(kind) };
    const asset = assetSource(id, label);
    if (asset === null) pieces.push({ id, node: pieceNode(kind, targetBounds) });
    entries.push({ base, asset });
  }
  const { geometry, nodeOf } = extendGeometry(clearArena(family.compose(seed), layout, family.id), pieces);
  const objects: SemanticObject[] = entries.map(({ base, asset }) => ({
    ...base,
    source: asset ?? { kind: 'geom', node: nodeOf.get(base.stableId) as number },
  }));

  const world: WorldDoc = sealSimHash({ irVersion: WORLD_DOC_VERSION, simRevision: 0, lookRevision: 0, sim, look });
  return {
    version: BLUEPRINT_VERSION_V2,
    sessionSeed: seed,
    title: spec.title,
    intent: intentOf(spec),
    world,
    geometry,
    objects,
    shapes: [],
  };
}
