/**
 * **Compiler (P13 T11): záměr → blueprint.**
 *
 * Druhá ze dvou modelových fází (design book §10.1). Planner odpověděl na
 * otázku „o jakém místě to je"; compiler odpovídá na „jak se to postaví".
 *
 * ## Compiler nedostane větu uživatele. Vůbec.
 *
 * Vstupem je **kanonický záměr** — `canonical()` nad tím, co planner napsal
 * a co prošlo `readPlannerEmission()`. Ne syrová odpověď modelu a ne původní
 * věta. Jsou pro to tři důvody a všechny jsou z §10.1:
 *
 * 1. Sémantika je na jednom kanonickém místě. Kdyby ji compiler četl znovu
 *    z věty, byly by dva výklady jedné věty a nikdo by nevěděl, který platí.
 * 2. Při opravě formální vady (T12) se nesmí znovu interpretovat zadání —
 *    jinak druhé kolo postaví jiný svět než první.
 * 3. Syrová odpověď plannera může nést pole navíc, komentář nebo poloviční
 *    JSON. Do tohohle promptu jde jen to, co branou prošlo.
 *
 * Vynucuje to **typ**: `buildCompilerRequest` bere `PlannerEmission`, což je
 * návratový typ brány. Syrový `unknown` se sem nedá předat, aniž by se to
 * nejdřív provalidovalo.
 *
 * ## Kontrakt světového grafu se sem NEOPISUJE
 *
 * `world` v odpovědi je celá emise světového grafu — týž kontrakt, jaký měří
 * `buildEmissionRequest()`. Jeho text se sem proto **vkládá doslova**, ne
 * přepisuje. `src/model/prompt.ts` v hlavičce popisuje, proč: ten tvar není
 * z ničeho odvoditelný, model ho nemá odkud vzít, a **první živý běh na něm
 * padl 3× ze 3**. Druhá formulace téhož by se s originálem rozešla tiše a
 * poznalo by se to až na tom, že model přestane trefovat `layout.width`.
 *
 * ## Manifest schopností se odvozuje ze schémat
 *
 * Slovník uzlů, varianty kusů, kotvy, odstíny i všechny stropy se čtou
 * z `src/geom/program.ts` a `src/shape/schema.ts`. Argumenty jednotlivých uzlů
 * odvodit nejdou — ty stojí v tabulkách níž, a **jejich úplnost hlídá
 * překladač**: `Record<ShapeNodeKind, string>` bez jednoho klíče se nepřeloží.
 * To je pojistka, kterou test nepotřebuje; test navíc hlídá, že se každé jméno
 * do hotového textu doopravdy dostalo.
 */

import {
  ANCHOR_SITES,
  GEOM_LIMITS,
  GEOM_VERSION,
  MAX_CURVE_POINTS,
  MAX_SWEEP_SEGMENTS,
  OPERATION_KINDS,
  PIECE_VARIANTS,
  SHAPE_KINDS,
  SWATCH_NAMES,
  TERRAIN_VARIANTS,
  type PieceKind,
} from '../geom/program';
import { canonical } from '../ir/worlddoc';
import { SHAPE_NODE_GROUPS } from '../shape/schema';
import { SHAPE_LIMITS, type ShapeNodeKind } from '../shape/types';

import { EMISSION_MODEL, buildEmissionRequest, type Grammar, type UpstreamRequest } from './prompt';
import { PLANNER_ANSWER_FIELDS, type PlannerEmission } from './worldstream-intent';
import { REFINE_ANSWER_FIELDS } from './worldstream-refine';
import { CHUNK_FIELDS, EMISSION_CHUNKS, type ChunkName } from './emission-merge';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import { buildAssetBrief } from './worldstream-asset-brief';

/** Značka fáze. Odlišuje blueprint od plánu i od staré emise v logu i v provenance. */
export const COMPILER_STAGE = 'worldstream-blueprint';

/**
 * Řádek, za kterým ve zprávě stojí vložený kontrakt světového grafu.
 *
 * Exportovaný, aby ho test našel v **hotovém textu**, ne v konstantě vedle něj.
 * Kdyby se ověřovala konstanta, prošla by i zpráva, do které se vložení
 * nedostalo.
 */
export const WORLD_CONTRACT_MARKER = 'BEGIN WORLD CONTRACT — this describes the "world" field only';
export const WORLD_CONTRACT_END = 'END WORLD CONTRACT';

/** Řádek, za kterým stojí ukázková odpověď a nic jiného. */
export const BLUEPRINT_EXAMPLE_MARKER =
  'An example answer for a request unrelated to yours. Copy the SHAPE and nothing else.';

/* ------------------------------------------------------------------ *
 * Argumenty uzlů. Odvodit ze zod schématu nejdou; úplnost drží překladač.
 * ------------------------------------------------------------------ */

/** Umístění, které nese každý tvarový uzel kompozice. Volitelné — nuly se nepíšou. */
const GEOM_PLACEMENT =
  'at [x,y,z], yaw, pitch, roll (quarter turns, -4 < t < 4), scale [sx,sy,sz] (0.1 to 8)';

type GeomNodeKind = (typeof SHAPE_KINDS)[number] | (typeof OPERATION_KINDS)[number];

const GEOM_NODE_ARGUMENTS: Readonly<Record<GeomNodeKind, string>> = {
  mass: `variant, ${GEOM_PLACEMENT}`,
  column: `variant, ${GEOM_PLACEMENT}`,
  arch: `variant, ${GEOM_PLACEMENT}`,
  panel: `variant, ${GEOM_PLACEMENT}`,
  organic: `variant, ${GEOM_PLACEMENT}`,
  fixture: `variant, ${GEOM_PLACEMENT}`,
  actor: `variant, ${GEOM_PLACEMENT}`,
  terrain: 'variant, extent [w,d], amplitude (0 to 8), seed, at, yaw — no scale, extent IS the size',
  sweep: `profile [[u,v], ...] (3 to ${MAX_CURVE_POINTS}, a closed outline with area), path [[x,y,z], ...] (2 to ${MAX_CURVE_POINTS}, not all the same point), segments (2 to ${MAX_SWEEP_SEGMENTS}), swatch, ${GEOM_PLACEMENT}`,
  group: 'children [i, ...] (1 to 16) — the ONLY node that carries several children, so the scene is a group',
  repeat: 'child, count (2 to 16, the original included), step [x,y,z]',
  mirror: 'child, axis ("x" or "z" — never "y", the world stands on the ground), about',
  carve: 'child, at [x,y,z], size [w,h,d] — drops triangles whose centre falls inside the box',
  scatter: 'child, count (2 to 24), radius (0.5 to 32), seed',
  arrayAlongCurve: `child, count (2 to 24), points [[x,y,z], ...] (2 to ${MAX_CURVE_POINTS}) — copies are moved, never turned along the tangent`,
  anchorTo: `child, target (another node), site (${ANCHOR_SITES.join('|')}), offset — the TARGET is a reference and is not built, so put it in the same group if you want to see it`,
};

const SHAPE_NODE_ARGUMENTS: Readonly<Record<ShapeNodeKind, string>> = {
  sphere: 'radius',
  box: 'size [w,h,d] — the FULL size, not the half-extent',
  roundBox: 'size [w,h,d], radius',
  capsule: 'height, radius',
  cylinder: 'height, radius',
  cone: 'height, radius',
  torus: 'majorRadius, minorRadius',
  plane: 'normal [x,y,z], offset',
  prism: 'sides (3 to 12), radius, height',
  ellipsoid: 'radii [rx,ry,rz]',
  union: 'children [i, ...] (2 to 8), k — k is the blend radius; LEAVE IT OUT for a sharp edge, never write 0',
  subtract: 'children [i, ...] — the first child minus the rest, k optional',
  intersect: 'children [i, ...], k optional',
  translate: 'child, offset [x,y,z]',
  rotate: 'child, yaw, pitch, roll (radians)',
  scale: 'child, factor [sx,sy,sz] (0.05 to 20, never negative — use mirror to flip)',
  mirror: 'child, axis, about',
  twist: 'child, axis, radiansPerUnit (-8 to 8)',
  bend: 'child, axis, curvature (-8 to 8)',
  taper: 'child, axis, amount (-4 to 4)',
  displace: 'child, amplitude (0 to 8), frequency (0.01 to 16), seed — surface noise, the expensive node',
  revolve: 'child, axis, radius, sweep (0.05 to 2*PI radians, the WHOLE angle: PI is a half arch)',
  repeat: 'child, count (2 to 64), step [x,y,z]',
  radialArray: 'child, count, axis, radius',
  arrayAlongCurve: `child, count, points [[x,y,z], ...] (2 to ${SHAPE_LIMITS.maxCurvePoints})`,
  clip: 'child, region { kind: "halfSpace", normal, offset } or { kind: "box", center, size }',
};

/* ------------------------------------------------------------------ *
 * Ukázková odpověď.
 * ------------------------------------------------------------------ */

/**
 * Ukázka musí být **sémanticky vzdálená celé zmrazené sadě i ukázce
 * plannera**, jinak nejde poznat opisování. `evals/worldstream/create.jsonl`
 * má katedrálu z kontejnerů, spirálovou knihovnu, orloj a majáky;
 * `worldstream-examples.ts` má observatoř na ledě. Včelín na stráni nemá
 * s ničím z toho společnou ani rodinu tvarů.
 */
export const EXAMPLE_BLUEPRINT_ANSWER = {
  geometry: {
    version: GEOM_VERSION,
    nodes: [
      { kind: 'terrain', variant: 'ridge', extent: [26, 18], amplitude: 0.7, seed: 91 },
      { kind: 'panel', variant: 'wall', at: [-9, 0.6, -5], scale: [3, 1.2, 1] },
      { kind: 'repeat', child: 1, count: 6, step: [3.4, 0, 0] },
      { kind: 'mass', variant: 'plinth', at: [-5, 0.3, 2], scale: [1.4, 0.6, 1.4] },
      { kind: 'repeat', child: 3, count: 3, step: [5, 0, 0] },
      { kind: 'fixture', variant: 'crate', at: [4.5, 0.3, 5.5], scale: [0.8, 0.8, 0.8] },
      { kind: 'organic', variant: 'shrub', at: [-10, 0, 7] },
      { kind: 'scatter', child: 6, count: 9, radius: 8, seed: 4021 },
      { kind: 'group', children: [0, 2, 4, 5, 7] },
    ],
    root: 8,
  },
  shapes: [
    {
      shapeId: 'tallHiveShape',
      stableId: 'tallHive',
      nodes: [
        { kind: 'cylinder', height: 0.42, radius: 0.62 },
        { kind: 'translate', child: 0, offset: [0, -0.5, 0] },
        { kind: 'translate', child: 0, offset: [0, -0.06, 0] },
        { kind: 'translate', child: 0, offset: [0, 0.38, 0] },
        { kind: 'cone', height: 0.5, radius: 0.72 },
        { kind: 'translate', child: 4, offset: [0, 0.85, 0] },
        { kind: 'union', children: [1, 2, 3, 5], k: 0.05 },
      ],
      root: 6,
      targetBounds: { min: [-0.8, -0.8, -0.8], max: [0.8, 1.2, 0.8] },
      anchors: [{ name: 'lid', at: [0, 1.1, 0], normal: [0, 1, 0] }],
      materialIntent: 'straw',
      priority: 10,
    },
  ],
  placements: [
    {
      stableId: 'hillsideTerrace',
      source: { kind: 'geom', node: 0 },
      targetBounds: { min: [-13, -1, -9], max: [13, 1, 9] },
    },
    {
      stableId: 'drystoneWall',
      source: { kind: 'geom', node: 2 },
      targetBounds: { min: [-10.5, 0, -5.6], max: [9.5, 1.4, -4.4] },
    },
    {
      stableId: 'tallHive',
      source: { kind: 'shape', shapeId: 'tallHiveShape' },
      targetBounds: { min: [-0.9, 0.6, 1.1], max: [0.9, 2.4, 2.9] },
    },
    {
      stableId: 'smokerBox',
      source: { kind: 'geom', node: 5 },
      targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] },
    },
  ],
  world: {
    irVersion: 'v1',
    simRevision: 0,
    lookRevision: 0,
    sim: {
      layout: { width: 14, height: 9 },
      grid: { cell: 1 },
      sockets: { pathStart: [1, 4], smokerPad: [4, 6], hivePad: [9, 4], gatePad: [12, 4] },
      collisionAabb: {
        keeper: [1, 4, 1, 1],
        smoker: [4, 6, 1, 1],
        tallHive: [9, 4, 1, 2],
        apiaryGate: [12, 4, 1, 2],
      },
      entities: {
        keeper: { role: 'actor', socket: 'pathStart', state: 'idle' },
        smoker: { role: 'pickup', socket: 'smokerPad', state: 'loose' },
        tallHive: { role: 'prop', socket: 'hivePad', state: 'sealed' },
        apiaryGate: { role: 'goal', socket: 'gatePad', state: 'shut', locked: true },
      },
      state: {
        counters: {},
        flags: { hiveCalm: { init: false } },
        timers: {},
        zones: {},
        slots: 1,
      },
      rules: {
        liftSmoker: {
          phase: 0,
          priority: 0,
          event: { kind: 'onPickup', role: 'pickup' },
          condition: null,
          actions: [
            { kind: 'giveItem', slot: 0, item: 'smoker' },
            { kind: 'despawn', target: 'smoker' },
          ],
        },
        calmHive: {
          phase: 0,
          priority: 1,
          event: { kind: 'onAction', actionId: 'use', target: 'tallHive' },
          condition: { kind: 'hasItem', slot: 0, item: 'smoker' },
          actions: [
            { kind: 'setState', target: 'tallHive', value: 'open' },
            { kind: 'setFlag', flag: 'hiveCalm', value: true },
            { kind: 'setLocked', target: 'apiaryGate', locked: false },
          ],
        },
        win: {
          phase: 1,
          priority: 0,
          event: { kind: 'onEnterZone', entity: 'keeper', zone: 'gatePad' },
          condition: { kind: 'flagIs', flag: 'hiveCalm', value: true },
          actions: [{ kind: 'win' }],
        },
      },
    },
    look: {
      modules: { apiaryGate: { family: 'panel', params: { thickness: 0.2 } } },
      palette: 'sand',
      lightRig: 'rim',
      atmosphere: 'clear',
      materialRoles: {},
      camera: { kind: 'orbit' },
      audio: {},
    },
  },
} as const;

/**
 * Jména, která patří výhradně ukázce.
 *
 * Táž doktrína jako o patro výš u plannera. Většinu z nich zachytí už spojení
 * s plánem — placement na neznámé `stableId` se odmítne sám — ale `shapeId`
 * a `materialIntent` v plánu nikde nestojí, takže je nic jiného nechytne.
 */
export const EXAMPLE_ONLY_IDENTIFIERS: readonly string[] = [
  ...EXAMPLE_BLUEPRINT_ANSWER.placements.map((placement) => placement.stableId),
  ...EXAMPLE_BLUEPRINT_ANSWER.shapes.map((shape) => shape.shapeId),
];

/* ------------------------------------------------------------------ *
 * Manifest schopností.
 * ------------------------------------------------------------------ */

/**
 * Co jazyk umí, odvozené ze schémat.
 *
 * Kdyby se to opsalo, přidaná varianta kusu by ve slovníku modelu chyběla
 * a nikdo by se to nedozvěděl — model by ji prostě nikdy nepoužil a vypadalo by
 * to jako jeho volba.
 */
export function capabilityManifest(): string {
  const pieceLines = (Object.keys(PIECE_VARIANTS) as PieceKind[]).map(
    (kind) => `  ${kind}: ${PIECE_VARIANTS[kind].join(' | ')}`,
  );

  const geomLines = SHAPE_KINDS.map(
    (kind) => `  ${kind} — ${GEOM_NODE_ARGUMENTS[kind]}`,
  ).concat(OPERATION_KINDS.map((kind) => `  ${kind} — ${GEOM_NODE_ARGUMENTS[kind]}`));

  const shapeLines = Object.entries(SHAPE_NODE_GROUPS).flatMap(([group, kinds]) => [
    `  ${group}:`,
    ...kinds.map((kind) => `    ${kind} — ${SHAPE_NODE_ARGUMENTS[kind]}`),
  ]);

  return [
    'GEOMETRY — the composition. One flat table of nodes; every child index points STRICTLY LOWER',
    'than the row using it, and root is the last thing built. Every row must be reachable from root:',
    'an unreachable row is still built by the compiler and would blow the budget uncounted.',
    `version is "${GEOM_VERSION}". At most ${GEOM_LIMITS.maxNodes} rows, and at most`,
    `${GEOM_LIMITS.maxInstances} placed pieces AFTER the arrays expand — repeat 16 over scatter 24 is`,
    '384 pieces from two rows, and that is rejected.',
    '',
    'Kit pieces and their variants:',
    ...pieceLines,
    `  terrain: ${TERRAIN_VARIANTS.join(' | ')}`,
    '',
    `Vertex swatches for sweep: ${SWATCH_NAMES.join(' | ')}. Nothing outside that list exists.`,
    '',
    'Geometry nodes:',
    ...geomLines,
    '',
    'SHAPES — hero objects, written as a distance field the browser meshes itself. Same table rule:',
    'children point strictly lower, root is last, every row reachable.',
    `At most ${SHAPE_LIMITS.maxNodes} rows, depth ${SHAPE_LIMITS.maxDepth}, ${SHAPE_LIMITS.maxInstances} copies after arrays expand,`,
    `and ${SHAPE_LIMITS.maxEvaluations} distance evaluations per grid cell. That last one is the real cost:`,
    'a shared subtree is free in the copy count and is not free here.',
    '',
    'Shape nodes:',
    ...shapeLines,
    '',
    'A shape carries: shapeId, stableId (the object it belongs to), nodes, root, targetBounds',
    '{ min, max } in SHAPE space, anchors [{ name, at, normal }] where sockets sit, materialIntent',
    '(camelCase, no spaces — a name, never a colour and never a phrase: brushedSteel, not "brushed steel"),',
    'priority (higher is meshed first).',
    'You do NOT write grid resolution, quality, cost or meshing order. Those are pipeline decisions.',
    // **Naměřeno 14. 9. 2026 na c07.** „Les, kde stromy jsou hrudní koše" přišel
    // jako jeden tvar: strom o 5,3 m se žebry 15 cm, zopakovaný 3× a 2×, takže
    // targetBounds byl 14,5 m a buňka mřížky 45 cm — žebra se rozpadla. Mřížka
    // je pevná, takže opakování se platí rozlišením a platí se zbytečně. Brána
    // `repeatedHeroIssue` to odmítá; tenhle odstavec je ta věta předem.
    'ONE shape is ONE object. If a hero appears many times — a forest of the same tree, a row of',
    'the same lamp — write it ONCE, with targetBounds around that single copy, and put the copies',
    'in the composition. The mesh grid is fixed, so a targetBounds stretched around repeated copies',
    'spends its resolution on the gaps between them and the detail inside each one is lost.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Požadavek.
 * ------------------------------------------------------------------ */

/** Pole, která tahle fáze v odpovědi žádá. Důvod je u `PLANNER_ANSWER_FIELDS`. */
export const COMPILER_ANSWER_FIELDS = ['geometry', 'shapes', 'placements', 'world'] as const;

/**
 * Věty, kterými se celý požadavek zúží na jeden kus.
 *
 * Kusy běží souběžně nad **týmž rejstříkem plánovače**, takže každý vidí
 * všechny identity — nevidí jen text, který zrovna píšou ostatní. Jediná
 * vazba, která hranici kusu překračuje, je `placements → geometry.nodes[i]`,
 * a tu po slepení kontroluje `mergeEmissionChunks`.
 */
/**
 * Věta, kterou se kus v požadavku přihlásí — a podle které se zpátky pozná
 * (`requestChunk`). Je to funkce, a ne text na dvou místech, ze stejného
 * důvodu, jaký je u `PLANNER_ANSWER_FIELDS`: dvě kopie se rozejdou a
 * rozlišovač tiše přestane rozlišovat.
 */
function chunkClaim(chunk: ChunkName): string {
  return `YOU ARE WRITING ONE PART OF THAT ANSWER. Write exactly these top-level fields and no others: ${CHUNK_FIELDS[chunk].join(', ')}.`;
}

function chunkNarrowing(chunk: ChunkName): string[] {
  const theirs = EMISSION_CHUNKS.filter((name) => name !== chunk)
    .flatMap((name) => CHUNK_FIELDS[name])
    .join(', ');

  return [
    '',
    chunkClaim(chunk),
    `The fields ${theirs} are being written right now by parallel requests against this same registry.`,
    'Leave them out entirely. A field written twice is rejected by the merge, not silently overwritten,',
    'so an empty placeholder is worse than an absent field.',
    ...(chunk === 'objects'
      ? [
          'Your placements may point at geometry rows you did not write: source {kind:"geom",node:<row>}',
          'indexes the geometry table from the architecture part, in the order it declares it.',
        ]
      : []),
  ];
}

/**
 * Která ze tří fází si o tenhle požadavek řekla.
 *
 * ⚠ **Rozhoduje seznam žádaných polí, NIKDY pořadí volání — naměřeno
 * 5. 9. 2026.** Jedna věta znamená dvě volání modelu, ale opravné kolo posílá
 * compiler požadavek znovu, takže „první je planner" je pravidlo, které se
 * rozbije při prvním odmítnutí. Spike `d749ce7` poslal na jednu větu čtyři
 * požadavky v pořadí planner, compiler, compiler, compiler.
 *
 * **Třetí fáze `refine` přibyla s `T35-actsthree4`**, kdy druhá věta dostala
 * tutéž záložní větev jako první: sklad musí poznat, jestli se ho ptá stavba
 * světa, nebo změna běžícího. Bez toho by vydal na požadavek o změnu plán
 * světa a `readRefineEmission()` by ho odmítl jako odpověď špatné fáze.
 *
 * Funkce bydlí tady, protože odsud jsou vidět všechny tři seznamy.
 * V úložišti uvařených světů by existovala podruhé.
 */
export function requestStage(request: UpstreamRequest): 'planner' | 'compiler' | 'refine' | null {
  if (request.system.includes(`${COMPILER_ANSWER_FIELDS.join(', ')}.`)) return 'compiler';
  if (request.system.includes(`${PLANNER_ANSWER_FIELDS.join(', ')}.`)) return 'planner';
  if (request.system.includes(`${REFINE_ANSWER_FIELDS.join(', ')}.`)) return 'refine';
  return null;
}

/**
 * Který kus si tenhle požadavek říká napsat, nebo `null` u celé odpovědi.
 *
 * Je to táž cesta jako u `requestStage()` — rozhoduje text požadavku, ne
 * pořadí ani proměnná vedle něj — takže to platí i na požadavek přečtený
 * z archivu, kde žádný volající není.
 */
export function requestChunk(request: UpstreamRequest): ChunkName | null {
  return EMISSION_CHUNKS.find((chunk) => request.system.includes(chunkClaim(chunk))) ?? null;
}

/**
 * Kus, o který si tenhle požadavek říká. `undefined` = celá odpověď, tedy
 * dnešní jediné volání.
 *
 * **Narovnání, ne protiřečení.** Seznam „top-level fields are exactly" zůstává
 * v požadavku beze změny — čte ho `requestStage()` a přehrávání archivu podle
 * něj pozná fázi. Kus se pod něj dopisuje jako zúžení: tvar odpovědi je pořád
 * týž, píše se z něj jen část.
 */
export function buildCompilerRequest(
  plan: PlannerEmission,
  grammar: Grammar,
  chunk?: ChunkName,
): UpstreamRequest {
  const placeableIds = plan.objects
    .filter((object) => object.role !== 'effect')
    .map((object) => object.stableId);

  const system = [
    'You are given a finished description of a place and you write the geometry that builds it.',
    'Somebody else already decided WHAT the place is. You decide how it stands up.',
    '',
    'Answer with a single JSON object and nothing else. Its top-level fields are exactly:',
    `${COMPILER_ANSWER_FIELDS.join(', ')}. The only optional additional field is architecture. Other fields are rejected, including a title —`,
    'the system writes that from the intent you were given.',
    ...(chunk === undefined ? [] : chunkNarrowing(chunk)),
    'Optional architecture is an array of authored rooms/corridors: {stableId,kind:"room"|"corridor",at:[x,y,z],width,depth,height,thickness,openings:[{wall:"north"|"south"|"east"|"west",offset,width,height}]}.',
    'at is floor center in meters. Openings start at offset from the negative end of that wall and cut from floor upward. Walls are continuous, floors are continuous slabs; no roof is added.',
    'Use source:{kind:"architecture"} on the matching stableId placement. This lowers into your authored geometry; never duplicate those walls in geometry.nodes. geometry may have nodes:[] when architecture supplies it.',
    'Keep opening approach areas clear (0.6m on either side). Satisfy sceneSpec relations using actual contain-fit asset dimensions, +Z forward and declared support surfaces. near means at most 2m surface distance.',
    '',
    capabilityManifest(),
    '',
    'PLACEMENTS bind the two together. One entry per object you were given, except objects whose role',
    'is "effect" — air, light and weather have no geometry and are carried by the look layer.',
    'Each entry carries: stableId (one of the ids you were given, never a new one),',
    'source ({ kind: "geom", node: <row index> }, { kind: "shape", shapeId: <one of yours> }, or an exact approved asset source below),',
    'targetBounds { min, max } in WORLD space — the box the object occupies on the ground.',
    '',
    'THE LINK RUNS BOTH WAYS. A shape names its object in stableId and that object must source from',
    'that shape. A shape nobody sources from is meshed and never shown, and the object stays a rough',
    'lump for ever with nothing reporting it.',
    '',
    'Choose an approved asset for a matching known object, parametric composition for architecture/terrain,',
    'and an authored shape for unusual forms. Heroes are NOT required to be shapes. Preserve every identity.',
    'Candidates are suggestions: a surreal object must not be renamed to fit the catalog. A cache miss is explicit.',
    'For assets write binding { collider: targetBounds, sockets: [], parts: [] }; add entityId only for an existing sim entity.',
    'If using sockets or parts, transform the approved local sockets into world space with uniform bottom-centered contain fit.',
    'Preserve native proportions and meters. Five people need five placements; sharing an asset never merges their identities.',
    'Asset placements may carry yaw in radians from -PI to PI. Native forward is +Z; toward a target use atan2(target.x-subject.x,target.z-subject.z).',
    'Missing asset yaw is derived from a facing relation. Explicit yaw is respected and checked. Sockets and collider remain accepted world coordinates and must match the rotated fit; never combine nonzero yaw with anisotropic stretch.',
    'For seated/on contacts, placement.supportSocket names an imported downward socket (for example seat) already declared in binding.sockets. Position that exact world socket on the target support surface, not the feet on top of the chair.',
    'Terrain on-relations are checked against actual triangles at the contact. Do not use the top of the terrain bounding bounds as ground height; wide rigid feet intersecting a slope are rejected with a contact diagnostic.',
    'For a visible lamp or terminal status, binding.signalFlag may name an existing sim.state.flags entry; the renderer displays its current value. Never invent a flag outside world.sim.',
    'Honor sceneSpec counts, negations and relationships. Use an opening and clear passage for every usable door.',
    '',
    'You never answer with the name of a style, a family or a preset. There is no library of finished',
    'places to pick from. If you write a string where a program belongs, the answer is rejected as',
    'geometry you did not author, because that is exactly what it is.',
    '',
    WORLD_CONTRACT_MARKER,
    // Vloženo doslova z `buildEmissionRequest`. Prompt je prázdný schválně:
    // bere se jen systémová část, do které se text zadání nikdy nedostane.
    buildEmissionRequest('', grammar).system,
    WORLD_CONTRACT_END,
    '',
    // ⚠ **Zavření `NO_FIT` je oprava naměřeného zaseknutí, ne opatrnost.**
    // Spike z 5. 9. 2026 (`d749ce7`, věta `c01`): Codex napsal geometrii, tvary
    // i placementy tak, že je compiler přijal, a odmítl **jen** sim —
    // `sim: null`, `simOutcome: "NO_FIT"`. Tři opravná kola ho z toho
    // nedostala, protože věta o odmítnutí sama nabízela „keep declining".
    // Kontrakt nad tímhle blokem tu nabídku dělá právem: sdílí se s cestou,
    // kde model dostane holou větu a nemusí za ní nic stát. Sem se ale vkládá
    // doslova, takže se ta nabídka musí zavřít tady, ne v něm.
    'THE CONTRACT ABOVE OFFERS YOU NO_FIT. On this path you do not have it.',
    'It is written for a stage that may be handed a sentence with nothing behind it. You are handed',
    'a concrete requested place. Propose a reachable action using a visible object already present:',
    'open its door, switch its lamp, or activate its mechanism. Bind that object to the corresponding entity.',
    'The objective must express this action. Do not invent an invisible universal win trigger.',
    'VISITOR INPUT CONTRACT: visible controls dispatch onAction, never onClick. For a terminal or switch,',
    'declare event {kind:"onAction",actor:"<existing actor entity>",actionId:"activate",target:"<visible object entity>"}.',
    'onClick is a legacy surface event with no visitor input producer in this runtime; do not use it for interactive rules.',
    'A witness step is {tick:0,actor:"<same actor>",actionId:"activate",target:"<same object>"}. Keep the actual requested effects',
    'and derive the objective from their resulting state. A win alone is not a replacement for switching the visible lamp.',
    'Rules and witness still have to certify; visual quality never excuses invalid behavior.',
    '',
    BLUEPRINT_EXAMPLE_MARKER,
    // **Odsazení tu musí zůstat**, ze stejného naměřeného důvodu jako
    // u ukázky v `./prompt.ts`: kompaktní ukázka zkrátila odpovědi a zaplatila
    // se vynechanými poli. Model si odsazený příklad prochází po řádcích jako
    // seznam polí; na jednom dlouhém řádku tu oporu ztratí.
    JSON.stringify(EXAMPLE_BLUEPRINT_ANSWER, null, 2),
  ].join('\n');

  const user = [
    'REQUEST-SPECIFIC CONTENT is authoritative. The example above demonstrates shape only.',
    'Its beehive terrace is semantically wrong for any unrelated request, and copying its geometry',
    'table or its shape table is rejected even if you rename everything around them.',
    `Do not reuse these example-only names: ${EXAMPLE_ONLY_IDENTIFIERS.join(', ')}.`,
    '',
    `Every one of these objects needs a placement: ${placeableIds.join(', ')}.`,
    'An object you were given and did not place is an object the sentence asked for and the world',
    'does not contain.',
    '',
    'Build this place. This is the whole brief; there is no other text behind it:',
    canonical(plan),
    'APPROVED REPRESENTATION CANDIDATES (exact sources only; no URLs):',
    'Each object lists short candidate keys. Emit source:{kind:"asset",key:"assetId@version"}; the compiler resolves the immutable hash from this approved dictionary. Full exact source references remain accepted. Never combine key with other source fields. Shared candidates never merge object identities.',
    canonical(buildAssetBrief(plan.objects, WORLDSTREAM_ASSETS)),
  ].join('\n');

  return { model: EMISSION_MODEL, system, user };
}
