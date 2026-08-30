/**
 * Brána `ShapeProgram` — jediné místo, kde se rozhoduje, jestli je program od
 * modelu přijatelný.
 *
 * Dělí se to na dvě poloviny ze stejného důvodu jako u `src/geom/program.ts`:
 *
 * 1. **Schéma** (`zod`) uhlídá tvar jednoho řádku — jméno uzlu, jeho pole
 *    a rozsah každého čísla. `.strict()` znamená, že pole navíc je chyba, ne
 *    ticho: model, který si vymyslí `radius2`, se to musí dozvědět.
 * 2. **Strukturální kontrola** uhlídá to, co schéma z jednoho řádku nevidí —
 *    kam ukazují indexy, jak je strom hluboký a kolik kopií z něj vyleze po
 *    rozvinutí polí.
 *
 * **Každé číslo je ohraničené z obou stran, a není to kvůli nekonečnu.**
 * Naměřeno 28. 8. 2026 mutací, která `extent` horní mez sebrala: sada zůstala
 * zelená, protože `z.number()` ve verzi 4 nekonečno **ani `NaN` sám nepustí**
 * (`plainInfinity: false`, `plainNaN: false`). Horní mez tedy nechrání před
 * nekonečnem — chrání před **konečným nesmyslem**: poloměr 10⁶ je platné číslo,
 * projde vyhodnocovačem i meshovačem a vyrobí tvar, který zabere celou mřížku
 * a v obraze z něj není nic. Obě vlastnosti drží vlastní test, aby se tenhle
 * omyl nemohl vrátit.
 *
 * **Odmítá se celý program, nikdy se neořezává.** Oříznutý program je jiný
 * program než ten, který model napsal, a ten rozdíl by se nikde neukázal —
 * porotce by viděl tvar, o kterém by panel tvrdil, že ho napsal model.
 * Sebeoprava (vlna 2 T12) místo toho dostane důvod a napíše program znovu.
 */

import { z } from 'zod';

import {
  ARRAY_KINDS,
  COMBINATION_KINDS,
  DEFORMATION_KINDS,
  MASK_KINDS,
  PRIMITIVE_KINDS,
  SHAPE_LIMITS,
  TRANSFORM_KINDS,
  childIndicesOf,
  depths,
  evaluationCounts,
  instanceCounts,
  reachableFrom,
  type ShapeNode,
  type ShapeProgram,
} from './types';

/* ------------------------------------------------------------------ *
 * Ohraničené skaláry. Nic v programu nesmí být neohraničené.
 * ------------------------------------------------------------------ */

/** Souřadnice v souřadnicích tvaru, v metrech. */
const coordinate = z.number().min(-64).max(64);
const vector3 = z.tuple([coordinate, coordinate, coordinate]);

/** Rozměr tělesa. Nula není povolená — z nulového poloměru je díra, ne tvar. */
const extent = z.number().min(0.01).max(64);
const extent3 = z.tuple([extent, extent, extent]);

/** Úhel v radiánech. Volný, ale ne nekonečný — plných pět otáček stačí. */
const angle = z.number().min(-32).max(32);

/**
 * Násobek měřítka. Zdola 0,05, protože nula by ve vyhodnocovači dělila;
 * záporné číslo je zakázané, protože obrací normály a tvar se pak uvnitř
 * rozsvítí. Kdo chce převrátit, napíše `mirror`.
 */
const scaleFactor = z.number().min(0.05).max(20);
const scale3 = z.tuple([scaleFactor, scaleFactor, scaleFactor]);

/**
 * Plynulost kombinace. Ostrá hrana se píše **vynecháním** `k`, ne nulou:
 * polynomiální smooth-min dělí `k`, takže nula je `0/0` = `NaN` přesně na té
 * ploše, kvůli které se uzel píše. Táž kázeň jako `scaleFactor.min(0.05)`.
 */
const smoothness = z.number().gt(0).max(4);

/** Kolik kopií pole udělá. Součin přes celý strom hlídá `maxInstances`. */
const copyCount = z.int().min(2).max(64);

/**
 * Semínko šumu. Jediná PRNG projektu je `pure-rand` a bere celé číslo; rozsah
 * je kladný 32bitový, aby se nedalo emitovat semínko, které se v Node a
 * v prohlížeči zaokrouhlí jinak.
 */
const seedValue = z.int().min(0).max(2_147_483_647);

const nodeIndex = z.int().min(0).max(SHAPE_LIMITS.maxNodes - 1);

const axis = z.enum(['x', 'y', 'z']);

/**
 * Identifikátor. Uzavřená abeceda schválně: `shapeId` končí jako klíč v cache
 * i v registru reprezentací a `stableId` se objevuje ve vyrenderovaném HTML.
 * Model, který sem napíše celou větu, se to má dozvědět tady, ne až v DOM.
 */
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'identifier must start alphanumerically');

/* ------------------------------------------------------------------ *
 * Primitiva.
 * ------------------------------------------------------------------ */

const sphereNode = z.object({ kind: z.literal('sphere'), radius: extent }).strict();
const boxNode = z.object({ kind: z.literal('box'), size: extent3 }).strict();
const roundBoxNode = z
  .object({ kind: z.literal('roundBox'), size: extent3, radius: extent })
  .strict();
const capsuleNode = z
  .object({ kind: z.literal('capsule'), height: extent, radius: extent })
  .strict();
const cylinderNode = z
  .object({ kind: z.literal('cylinder'), height: extent, radius: extent })
  .strict();
const coneNode = z.object({ kind: z.literal('cone'), height: extent, radius: extent }).strict();
const torusNode = z
  .object({ kind: z.literal('torus'), majorRadius: extent, minorRadius: extent })
  .strict();
const planeNode = z
  .object({ kind: z.literal('plane'), normal: vector3, offset: coordinate })
  .strict();
const prismNode = z
  .object({
    kind: z.literal('prism'),
    sides: z.int().min(3).max(12),
    radius: extent,
    height: extent,
  })
  .strict();
const ellipsoidNode = z.object({ kind: z.literal('ellipsoid'), radii: extent3 }).strict();

/* ------------------------------------------------------------------ *
 * Kombinace.
 * ------------------------------------------------------------------ */

const combinationChildren = z.array(nodeIndex).min(2).max(8);

const unionNode = z
  .object({ kind: z.literal('union'), children: combinationChildren, k: smoothness.optional() })
  .strict();
const subtractNode = z
  .object({ kind: z.literal('subtract'), children: combinationChildren, k: smoothness.optional() })
  .strict();
const intersectNode = z
  .object({ kind: z.literal('intersect'), children: combinationChildren, k: smoothness.optional() })
  .strict();

/* ------------------------------------------------------------------ *
 * Transformace.
 * ------------------------------------------------------------------ */

const translateNode = z
  .object({ kind: z.literal('translate'), child: nodeIndex, offset: vector3 })
  .strict();
const rotateNode = z
  .object({
    kind: z.literal('rotate'),
    child: nodeIndex,
    yaw: angle,
    pitch: angle,
    roll: angle,
  })
  .strict();
const scaleNode = z
  .object({ kind: z.literal('scale'), child: nodeIndex, factor: scale3 })
  .strict();
const mirrorNode = z
  .object({
    kind: z.literal('mirror'),
    child: nodeIndex,
    axis,
    about: coordinate.optional(),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Deformace.
 * ------------------------------------------------------------------ */

const twistNode = z
  .object({
    kind: z.literal('twist'),
    child: nodeIndex,
    axis,
    radiansPerUnit: z.number().min(-8).max(8),
  })
  .strict();
const bendNode = z
  .object({
    kind: z.literal('bend'),
    child: nodeIndex,
    axis,
    curvature: z.number().min(-8).max(8),
  })
  .strict();
const taperNode = z
  .object({
    kind: z.literal('taper'),
    child: nodeIndex,
    axis,
    amount: z.number().min(-4).max(4),
  })
  .strict();
const displaceNode = z
  .object({
    kind: z.literal('displace'),
    child: nodeIndex,
    amplitude: z.number().min(0).max(8),
    frequency: z.number().min(0.01).max(16),
    seed: seedValue,
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Pole a maskování.
 * ------------------------------------------------------------------ */

const repeatNode = z
  .object({ kind: z.literal('repeat'), child: nodeIndex, count: copyCount, step: vector3 })
  .strict();
const radialArrayNode = z
  .object({
    kind: z.literal('radialArray'),
    child: nodeIndex,
    count: copyCount,
    axis,
    radius: extent,
  })
  .strict();
const arrayAlongCurveNode = z
  .object({
    kind: z.literal('arrayAlongCurve'),
    child: nodeIndex,
    count: copyCount,
    points: z.array(vector3).min(2).max(SHAPE_LIMITS.maxCurvePoints),
  })
  .strict();

const clipRegion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('halfSpace'), normal: vector3, offset: coordinate }).strict(),
  z.object({ kind: z.literal('box'), center: vector3, size: extent3 }).strict(),
]);

const clipNode = z
  .object({ kind: z.literal('clip'), child: nodeIndex, region: clipRegion })
  .strict();

export const shapeNodeSchema = z.discriminatedUnion('kind', [
  sphereNode,
  boxNode,
  roundBoxNode,
  capsuleNode,
  cylinderNode,
  coneNode,
  torusNode,
  planeNode,
  prismNode,
  ellipsoidNode,
  unionNode,
  subtractNode,
  intersectNode,
  translateNode,
  rotateNode,
  scaleNode,
  mirrorNode,
  twistNode,
  bendNode,
  taperNode,
  displaceNode,
  repeatNode,
  radialArrayNode,
  arrayAlongCurveNode,
  clipNode,
]);

const boundsSchema = z.object({ min: vector3, max: vector3 }).strict();

const anchorSchema = z
  .object({
    name: identifier.max(32),
    at: vector3,
    normal: vector3.optional(),
  })
  .strict();

export const shapeProgramSchema = z
  .object({
    shapeId: identifier,
    stableId: identifier,
    nodes: z.array(shapeNodeSchema).min(1).max(SHAPE_LIMITS.maxNodes),
    root: nodeIndex,
    targetBounds: boundsSchema,
    anchors: z.array(anchorSchema).max(16),
    materialIntent: identifier,
    priority: z.int().min(0).max(100),
  })
  .strict();

export interface ShapeValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Nejmenší délka vektoru, se kterou se dá dál počítat.
 *
 * Je to **délka, ne rovnost s nulou**, a rozhodlo o tom nezávislé review:
 * `normal: [1e-200, 0, 0]` není nulový vektor, ale `x * x` v druhé mocnině
 * podteče na nulu, odmocnina je nula, dělení jí dá nekonečno a součin
 * `Infinity * 0` je `NaN`. Práh je zároveň nejmenší rozměr, který schéma
 * u těles vůbec pustí (`extent`), takže nezakazuje nic použitelného.
 */
const MIN_VECTOR_LENGTH = 0.01;

function isTooShort(vector: readonly number[]): boolean {
  return Math.hypot(...vector) < MIN_VECTOR_LENGTH;
}

/**
 * To, co schéma z jednoho řádku nevidí: kam míří indexy, jak hluboký je strom,
 * kolik kopií z něj vyleze a jestli je kvádr kvádr.
 *
 * Vrací **všechny** nálezy, ne první — program se odmítá s důvodem, ze kterého
 * jde napsat lepší, a jeden důvod po druhém by znamenal tolik kol sebeopravy,
 * kolik je v programu chyb.
 */
function structuralIssues(program: z.infer<typeof shapeProgramSchema>): string[] {
  const issues: string[] = [];
  const fail = (message: string) => issues.push(message);

  if (program.root >= program.nodes.length) {
    fail(`root references node ${program.root} outside the table of ${program.nodes.length}`);
  }

  program.nodes.forEach((node, index) => {
    for (const child of childIndicesOf(node)) {
      // **Vzájemně výlučné, a v tomhle pořadí.** Index potomka mimo tabulku je
      // vždycky ≥ index vlastního řádku, protože ten je z definice menší než
      // délka tabulky — obrácené pořadí proto nechá hlášku o tabulce u potomka
      // navždy mrtvou a model dostane do sebeopravy „posuň ho pod sebe" i tam,
      // kde je vada „ukazuje na řádek, který neexistuje". To jsou dvě různé
      // opravy. U kořene je kontrola jen jedna, protože kořen vlastní index
      // nemá; tahle výlučnost se ho netýká.
      if (child >= program.nodes.length) {
        fail(`node ${index} references node ${child} outside the table of ${program.nodes.length}`);
      } else if (child >= index) {
        fail(`node ${index} references node ${child} at or above itself`);
      }
    }
    if (node.kind === 'plane' && isTooShort(node.normal)) {
      fail(`node ${index} is a plane with a zero normal`);
    }
    if (node.kind === 'clip' && node.region.kind === 'halfSpace' && isTooShort(node.region.normal)) {
      fail(`node ${index} clips against a half space with a zero normal`);
    }
    // Doménové opakování dělí krokem. Nulový krok je dělení nulou přes celou
    // mřížku, a smyčková varianta zaplatí `count` vyhodnocení za jednu kouli.
    if (node.kind === 'repeat' && isTooShort(node.step)) {
      fail(`node ${index} repeats with a step of no length`);
    }
    // Splývající kontrolní body dají křivku nulové délky a s ní nulovou tečnu,
    // ze které se normalizací stane `NaN` pozice všech kopií.
    if (node.kind === 'arrayAlongCurve') {
      const stuck = node.points.findIndex(
        (point, at) =>
          at > 0 &&
          isTooShort([
            point[0] - node.points[at - 1][0],
            point[1] - node.points[at - 1][1],
            point[2] - node.points[at - 1][2],
          ]),
      );
      if (stuck > 0) fail(`node ${index} has curve points ${stuck - 1} and ${stuck} on top of each other`);
    }
  });

  // Rovnost se odmítá spolu s obrácením, a je to oprava po review: podle
  // `targetBounds` potrubí tvar normalizuje a mřížkuje, takže plochý kvádr
  // (`min[1] === max[1]`, naprosto pravděpodobná emise pro list nebo desku)
  // dá krok buňky `(max - min) / N = 0`, dělení nulou a prázdný mesh.
  const [minX, minY, minZ] = program.targetBounds.min;
  const [maxX, maxY, maxZ] = program.targetBounds.max;
  if (minX >= maxX || minY >= maxY || minZ >= maxZ) {
    fail('targetBounds is flat or inverted on at least one axis');
  }

  const anchorNames = new Set<string>();
  for (const anchor of program.anchors) {
    if (anchorNames.has(anchor.name)) fail(`anchor ${anchor.name} is declared twice`);
    anchorNames.add(anchor.name);
  }

  // Rozpočty se počítají až nad neporušenou tabulkou. Nad cyklem nebo nad
  // odkazem mimo tabulku by `instanceCounts` i `depths` četly `undefined`
  // a vyrobily `NaN`, ze kterého se hlášku napsat nedá.
  if (issues.length > 0) return issues;

  const nodes = program.nodes as readonly ShapeNode[];

  // Mrtvý řádek se odmítá, ne přehlíží. Rozpočty se čtou z `[root]`, takže
  // uzel mimo strom je z nich vynechaný — a než se tahle kontrola přidala,
  // tvrdil komentář u `depths`, že se takový řádek „řeší jinde".
  const reached = reachableFrom(nodes, program.root);
  const orphans = nodes.map((_node, index) => index).filter((index) => !reached.has(index));
  if (orphans.length > 0) {
    fail(`nodes ${orphans.join(', ')} cannot be reached from root ${program.root}`);
  }

  const depth = depths(nodes)[program.root];
  if (depth > SHAPE_LIMITS.maxDepth) {
    fail(`program is ${depth} nodes deep, above maxDepth ${SHAPE_LIMITS.maxDepth}`);
  }

  const expanded = instanceCounts(nodes)[program.root];
  if (expanded > SHAPE_LIMITS.maxInstances) {
    fail(
      `program expands to ${expanded} copies, above maxInstances ${SHAPE_LIMITS.maxInstances}`,
    );
  }

  const evaluations = evaluationCounts(nodes)[program.root];
  if (evaluations > SHAPE_LIMITS.maxEvaluations) {
    fail(
      `program costs ${evaluations} evaluations per cell, above maxEvaluations ${SHAPE_LIMITS.maxEvaluations}`,
    );
  }

  return issues;
}

export function validateShapeProgram(input: unknown): ShapeValidation {
  const parsed = shapeProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`),
    };
  }

  const issues = structuralIssues(parsed.data);
  return { ok: issues.length === 0, issues };
}

/**
 * Přijme neznámý vstup, nebo vyhodí s pojmenovaným důvodem. Tudy vede **emisní
 * cesta** — tvar přišel zvenčí a ještě není `ShapeProgram`.
 *
 * **Meshovač tuhle funkci nevolá.** Do 30. 8. 2026 tu stálo, že „meshovač bere
 * jen tenhle vstup", a nebyla to pravda: `mesh-worker.ts` ji nevolal a program
 * s odkazem mimo tabulku prošel až do pole. Worker dnes volá
 * `validateShapeProgram()` sám, protože potřebuje **seznam vad**, ne výjimku —
 * ten seznam je vstup sebeopravy. Brána je táž, liší se jen odpověď.
 *
 * Návratový typ je ručně psaný `ShapeProgram` z `types.ts`, ne `z.infer`.
 * Je to jediná pojistka proti tomu, aby se schéma a kontrakt, který čte worker,
 * rozešly: kdyby schéma začalo propouštět uzel, o kterém `ShapeProgram` neví,
 * neprojde tenhle soubor přes `tsc`.
 */
export function parseShapeProgram(input: unknown): ShapeProgram {
  const validation = validateShapeProgram(input);
  if (!validation.ok) throw new Error(`invalid shape program: ${validation.issues.join('; ')}`);
  return shapeProgramSchema.parse(input);
}

/**
 * Slovník, který schéma doopravdy zná. Čte se z discriminated union, ne
 * z ručního seznamu — test tím drží připnuté, že `SHAPE_NODE_KINDS` v
 * `types.ts` a tenhle soubor mluví o týchž uzlech.
 */
export const SCHEMA_NODE_KINDS: readonly string[] = shapeNodeSchema.options.map(
  (option) => option.shape.kind.value as string,
);

/** Skupiny slovníku, jak je definuje design book §7.2. Pro test i pro UI. */
export const SHAPE_NODE_GROUPS = {
  primitive: PRIMITIVE_KINDS,
  combination: COMBINATION_KINDS,
  transform: TRANSFORM_KINDS,
  deformation: DEFORMATION_KINDS,
  array: ARRAY_KINDS,
  mask: MASK_KINDS,
} as const;
