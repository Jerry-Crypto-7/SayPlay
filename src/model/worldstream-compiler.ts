/**
 * **Compiler (P13 T11): odpověď modelu → `WorldstreamBlueprint`.**
 *
 * Tohle je místo, kde se rozhoduje, jestli tvrzení „model generuje 3D" platí.
 * Geometrie musí přijít **z odpovědi modelu**, ne z `chooseFamily()` — ta podle
 * design booku §7.5 přestává být produkční create cestou a zůstává jen
 * v nouzové větvi, viditelně označená. Tenhle soubor ji proto neimportuje
 * a nikdy nesmí; drží to i lexikální test nad jeho importy.
 *
 * ## Model píše čtyři věci a nic víc
 *
 * `geometry`, `shapes`, `placements`, `world`. Pole navíc je odmítnutí, ne
 * ticho — táž kázeň jako `.strict()` u `worldEmissionSchema`.
 *
 * **`title`, `sessionSeed` a `intent` píše systém.** `intent` přišel od
 * plannera a prošel branou; kdyby ho compiler přepsal, byly by dva výklady
 * jedné věty. `sessionSeed` je vstup jediné PRNG projektu a semínko od modelu
 * není semínko, je to přání. `title` se odvozuje ze záměru, což je o jednu věc
 * míň, kterou může model splést.
 *
 * ## Placements místo celých objektů, a je to kontrakt, ne úspora
 *
 * `SemanticObject` (§9.4) je sémantická polovina od plannera plus geometrická
 * od compileru. Kdyby model emitoval celý objekt, mohl by cestou přepsat
 * `label`, `role` nebo `importance` — a rozdíl by se projevil až tím, že druhá
 * věta („zvětši tu kopuli") nenajde objekt, který planner pojmenoval. Model
 * proto píše jen `{ stableId, source, targetBounds }` a spojení dělá systém.
 * Drift je tím **konstrukčně nemožný**, ne jen zakázaný.
 *
 * ## Co se oseká a co se odmítne
 *
 * Táž hranice jako v `src/worldstream/look-schema.ts`, a ze stejného důvodu:
 *
 * - **Číslo mimo rozpočet se oseká** a přizná se to (`adjustments`). Design
 *   book §7.5 to deterministickému systému výslovně dovoluje a pro demo je to
 *   jediná rozumná volba — odmítnout svět kvůli jedné souřadnici znamená
 *   ukázat porotci prázdno.
 * - **Tvar se odmítá.** Chybějící pole, řetězec místo tabulky, `targetBounds`
 *   bez `min`. To nejsou čísla mimo rozpočet, to je jiná odpověď.
 *
 * ## Opsaná ukázka se hledá v TABULCE, ne v celé odpovědi
 *
 * Kanonické porovnání celé odpovědi s ukázkou by tu bylo mrtvé — přesně jako
 * v `worldstream-intent.ts`, kde ho mutační kontrola 31. 8. 2026 usvědčila.
 * Odpověď doslova rovná ukázce nese i její `stableId`, a ty v plánu nestojí,
 * takže ji odmítne spojení s plánem dřív, než na porovnání dojde.
 *
 * Skutečný způsob, jak model ukázku opíše, je jiný: **převezme její tabulku
 * geometrie a přejmenuje jen placements**. To projde vším ostatním a vyrobí
 * všem porotcům tentýž včelín. Porovnává se proto kanonicky **tabulka uzlů**
 * geometrie a každého tvaru — jediná kontrola, a ta přísnější z obou.
 */

import { parseGeomProgram, validateGeomProgram } from '../geom/program';
import { canonical } from '../ir/worlddoc';
import { validateShapeProgram } from '../shape/schema';
import type { ShapeProgram } from '../shape/types';
import {
  MIN_TARGET_EXTENT,
  WORLD_COORDINATE_LIMIT,
  blueprintSchema,
  validateBlueprint,
  type SemanticObject,
  type SemanticSource,
  type WorldstreamBlueprint,
} from '../worldstream/schema';
import { findBlueprintReferenceIssues } from '../worldstream/references';

import { certifySteps, type Rejection, type Verdict } from './certify';
import { contextFromEmission, type RejectionContext } from './local/rejection-prompt';
import { repairEmission, type RepairNote } from './repair';
import { buildCompilerRequest, COMPILER_STAGE, EXAMPLE_BLUEPRINT_ANSWER } from './worldstream-prompt';
import { isExampleEmission, type Grammar, type UpstreamRequest } from './prompt';
import type { PlannedObject, PlannerEmission } from './worldstream-intent';

export { COMPILER_STAGE };

/** Pole, která model smí napsat. Cokoli navíc je odmítnutí. */
const ANSWER_FIELDS = ['geometry', 'shapes', 'placements', 'world'] as const;

export type CompilerRejection =
  /** Odpověď není objekt, nebo je to pole. */
  | 'NOT_AN_OBJECT'
  /** Chybí pole, je jiného typu, nebo je tam pole navíc. */
  | 'WRONG_SHAPE'
  /** Tabulka geometrie nebo tvaru je doslova z ukázky. */
  | 'EXAMPLE_COPIED'
  /** Místo programu přišlo jméno — rodina, styl, preset. */
  | 'GEOMETRY_NOT_AUTHORED'
  | 'GEOM_INVALID'
  | 'SHAPE_INVALID'
  /** Placement na neznámé jméno, nebo objekt ze zadání bez placementu. */
  | 'PLACEMENT_MISMATCH'
  /** Odkazy uvnitř blueprintu si odporují. */
  | 'REFERENCE_BROKEN'
  /** Hotová obálka neprošla vlastním schématem. */
  | 'BLUEPRINT_INVALID'
  /** Světový graf neprošel řetězem certifikace. */
  | 'WORLD_REJECTED';

/**
 * Jeden zásah systému do toho, co napsal model.
 *
 * `from`/`to` nese jen oseknuté číslo; rozhodnutí bez čísla (vynechaný efekt)
 * má jen `path` a `reason`. Jeden typ pro obojí schválně — čte to jeden panel
 * a dva typy by znamenaly dvě cesty vykreslení téhož sdělení.
 */
export interface BlueprintAdjustment {
  /** Cesta do dokumentu, `/`-oddělená. */
  readonly path: string;
  readonly reason: string;
  readonly from?: number;
  readonly to?: number;
}

/**
 * Odmítnutí světového grafu tak, jak ho vydala certifikace — celé.
 *
 * ⚠ **Bez tohohle pole dostane sedm různých vad tutéž radu.** `reason`,
 * `atStep` a hlavně `stage` se do `detail` nevejdou: řetězec `${stage}: ${detail}`
 * je věta pro člověka a fáze se z něj dá jen hádat předponou. `rejection-prompt.ts`
 * přitom má radu pro každou fázi zvlášť a u `NO_FIT` i doporučený tier — a ta
 * rada se bez struktury zahodí. Nese se proto **objekt, ne předpona**.
 *
 * `context` je to, co k odmítnutí přidává sama emise: kroky svědka pro adresu
 * `at step 2 (player: enter → arch)` a horizont pro doporučení tieru. Bere se
 * z **opraveného** dokumentu, protože `atStep` indexuje do něj, ne do toho,
 * co model poslal.
 */
export interface WorldRejection {
  readonly rejection: Rejection;
  readonly context: RejectionContext;
}

export type CompilerResult =
  | {
      readonly ok: true;
      readonly stage: typeof COMPILER_STAGE;
      readonly value: WorldstreamBlueprint;
      /** Verdikt řetězu nad `world`. Nese certifikát i to, co model napsal. */
      readonly verdict: Verdict;
      readonly adjustments: readonly BlueprintAdjustment[];
      /** Deterministické opravy světového grafu — mimo jiné nalezený svědek. */
      readonly repairs: readonly RepairNote[];
    }
  | {
      readonly ok: false;
      readonly reason: CompilerRejection;
      readonly detail: string;
      readonly issues: readonly string[];
      /**
       * Jen u `WORLD_REJECTED`, a ani tam ne vždycky — certifikace umí skončit
       * bez `Rejection` (nezpečetěný dokument nad `CERTIFIED` verdiktem).
       * Věta pro model si na to sáhne strážcem a jinak spadne na obecnou radu.
       */
      readonly world?: WorldRejection;
    };

export interface CompileOptions {
  /** Semínko relace. Píše ho systém, ne model. */
  readonly sessionSeed: number;
  /** Co se doopravdy poslalo nahoru. Zaznamenává se do verdiktu. */
  readonly upstream: UpstreamRequest;
}

function reject(
  reason: CompilerRejection,
  detail: string,
  issues: readonly string[] = [],
  world?: WorldRejection,
): CompilerResult {
  // Klíč se nepřipisuje s `undefined`, protože rovnost odmítnutí se porovnává
  // po polích a přítomný prázdný klíč je jiný objekt než nepřítomný.
  return world === undefined
    ? { ok: false, reason, detail, issues }
    : { ok: false, reason, detail, issues, world };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Opsaná ukázka.
 * ------------------------------------------------------------------ */

/** Tabulka uzlů bez obálky. Přejmenovaný tvar má pořád tutéž tabulku. */
function tableOf(value: unknown): string {
  const record = isRecord(value) ? value : {};
  return canonical({ nodes: record.nodes, root: record.root });
}

const EXAMPLE_GEOMETRY_TABLE = tableOf(EXAMPLE_BLUEPRINT_ANSWER.geometry);
const EXAMPLE_SHAPE_TABLES = new Set(EXAMPLE_BLUEPRINT_ANSWER.shapes.map(tableOf));

/**
 * Ukázkové světy, kterých se model může chytit. **Dva, ne jeden:** vedle
 * včelína z ukázky compileru vidí model i kartu s pákou z vloženého kontraktu
 * světového grafu, a ten druhý má vlastní hotovou kontrolu už od P1
 * (`isExampleEmission`), takže se znovu nepíše.
 */
const EXAMPLE_WORLD_CANONICAL = canonical(EXAMPLE_BLUEPRINT_ANSWER.world);

function isCopiedWorld(value: unknown): boolean {
  return isExampleEmission(value) || canonical(value) === EXAMPLE_WORLD_CANONICAL;
}

/* ------------------------------------------------------------------ *
 * Oseknutí cílového kvádru.
 * ------------------------------------------------------------------ */

function readTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const numbers = value.map((entry) => (typeof entry === 'number' ? entry : Number.NaN));
  if (numbers.some((entry) => !Number.isFinite(entry))) return null;
  return [numbers[0], numbers[1], numbers[2]];
}

const AXIS_NAMES = ['x', 'y', 'z'] as const;

/**
 * O kolik se otevře kvádr, který nemá tloušťku. **Dvojnásobek prahu, ne práh.**
 * Otevřít přesně na mez znamená spolehnout se na to, že rozdíl dvou desetinných
 * čísel vyjde přesně — a nevyjde: `64 - 63.99` je v plovoucí čárce
 * 0.009999999999990905, tedy o vlásek POD prahem, a schéma kvádr vzápětí
 * odmítne. Oseknutí by tak vyrobilo dokument, který sám neprojde vlastní bránou.
 */
const OPEN_BY = MIN_TARGET_EXTENT * 2;

/**
 * Přečte cílový kvádr a **osekne ho do světa**, nebo řekne, že to kvádr není.
 *
 * Pořadí kroků není libovolné: nejdřív se každá souřadnice vejde do světa,
 * pak se srovná pořadí os a **teprve nakonec** se dorovná nulová tloušťka.
 * Obráceně by se rozšíření o `MIN_TARGET_EXTENT` mohlo hned zase oseknout
 * mezí světa a kvádr by z brány vyšel plochý — tedy přesně to, čemu se má
 * zabránit. Na kraji světa se proto rozšiřuje směrem dovnitř.
 */
function clampBounds(
  raw: unknown,
  path: string,
  adjustments: BlueprintAdjustment[],
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!isRecord(raw)) return null;
  const min = readTriple(raw.min);
  const max = readTriple(raw.max);
  if (min === null || max === null) return null;

  const fit = (value: number, where: string): number => {
    const to = Math.min(WORLD_COORDINATE_LIMIT, Math.max(-WORLD_COORDINATE_LIMIT, value));
    if (to !== value) {
      adjustments.push({
        path: where,
        from: value,
        to,
        reason: `clamped into the world, which spans -${WORLD_COORDINATE_LIMIT} to ${WORLD_COORDINATE_LIMIT}`,
      });
    }
    return to;
  };

  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = fit(min[axis], `${path}/min/${axis}`);
    max[axis] = fit(max[axis], `${path}/max/${axis}`);

    if (min[axis] > max[axis]) {
      const low = max[axis];
      adjustments.push({
        path: `${path}/min/${axis}`,
        from: min[axis],
        to: low,
        reason: `min was above max on ${AXIS_NAMES[axis]}, so the two were swapped`,
      });
      max[axis] = min[axis];
      min[axis] = low;
    }

    if (max[axis] - min[axis] < MIN_TARGET_EXTENT) {
      // Uvnitř světa se rozšiřuje nahoru; u horní meze dolů, aby rozšíření
      // nepadlo rovnou zpátky pod strop.
      if (max[axis] + OPEN_BY <= WORLD_COORDINATE_LIMIT) {
        const to = min[axis] + OPEN_BY;
        adjustments.push({
          path: `${path}/max/${axis}`,
          from: max[axis],
          to,
          reason: `the box had no thickness on ${AXIS_NAMES[axis]}, and the mesh is normalised by dividing through it`,
        });
        max[axis] = to;
      } else {
        const to = max[axis] - OPEN_BY;
        adjustments.push({
          path: `${path}/min/${axis}`,
          from: min[axis],
          to,
          reason: `the box had no thickness on ${AXIS_NAMES[axis]} at the edge of the world, so it was opened downward`,
        });
        min[axis] = to;
      }
    }
  }

  return { min, max };
}

/* ------------------------------------------------------------------ *
 * Placements.
 * ------------------------------------------------------------------ */

function readSource(value: unknown): SemanticSource | string {
  if (!isRecord(value)) return 'source is not an object';
  if (value.kind === 'geom') {
    if (typeof value.node !== 'number' || !Number.isInteger(value.node) || value.node < 0)
      return 'source.node is not a row index';
    return { kind: 'geom', node: value.node };
  }
  if (value.kind === 'shape') {
    if (typeof value.shapeId !== 'string' || value.shapeId.length === 0)
      return 'source.shapeId is missing';
    return { kind: 'shape', shapeId: value.shapeId };
  }
  return `source.kind ${JSON.stringify(value.kind)} is neither "geom" nor "shape"`;
}

/* ------------------------------------------------------------------ *
 * Compiler.
 * ------------------------------------------------------------------ */

/**
 * Přečte odpověď modelu jako blueprint, nebo řekne proč ne.
 *
 * Pořadí kroků je součást kontraktu: **`GEOMETRY_NOT_AUTHORED` se soudí jako
 * první z geometrických vad.** Řetězec místo tabulky je platný JSON, takže by
 * obecná kontrola tvaru odpověděla „geometry.nodes chybí" — pravda, která
 * neřekne, co se stalo, a sebeoprava by na ni odpověděla dopsáním prázdné
 * tabulky místo tím, že program napíše.
 */
export function compileBlueprint(
  answer: unknown,
  plan: PlannerEmission,
  options: CompileOptions,
): CompilerResult {
  if (!isRecord(answer))
    return reject('NOT_AN_OBJECT', 'the answer is not a JSON object');

  const extra = Object.keys(answer).filter(
    (key) => !(ANSWER_FIELDS as readonly string[]).includes(key),
  );
  if (extra.length > 0)
    return reject(
      'WRONG_SHAPE',
      `the answer carries fields this stage does not write: ${extra.join(', ')}`,
      extra.map((key) => `/${key}: not one of ${ANSWER_FIELDS.join(', ')}`),
    );

  // --- geometrie ---------------------------------------------------------

  if (typeof answer.geometry === 'string')
    return reject(
      'GEOMETRY_NOT_AUTHORED',
      `geometry is the name ${JSON.stringify(answer.geometry)}, not a program; there is no library of finished places to pick from`,
    );
  if (!isRecord(answer.geometry))
    return reject('GEOMETRY_NOT_AUTHORED', 'geometry is missing; the composition has to be written');
  if (!Array.isArray(answer.geometry.nodes) || answer.geometry.nodes.length === 0)
    return reject(
      'GEOMETRY_NOT_AUTHORED',
      'geometry carries no node table, so nothing was authored',
    );

  if (tableOf(answer.geometry) === EXAMPLE_GEOMETRY_TABLE)
    return reject(
      'EXAMPLE_COPIED',
      'the geometry table is the example one, node for node; renaming what sits around it does not make it an answer',
    );

  const geomValidation = validateGeomProgram(answer.geometry);
  if (!geomValidation.ok)
    return reject('GEOM_INVALID', geomValidation.issues[0], geomValidation.issues);
  const geometry = parseGeomProgram(answer.geometry);

  // --- tvary -------------------------------------------------------------

  if (!Array.isArray(answer.shapes))
    return reject('WRONG_SHAPE', 'shapes is not an array; write an empty one if there are none');

  const shapes: ShapeProgram[] = [];
  for (const [index, raw] of answer.shapes.entries()) {
    if (EXAMPLE_SHAPE_TABLES.has(tableOf(raw)))
      return reject(
        'EXAMPLE_COPIED',
        `shapes[${index}] is the example shape table, node for node`,
      );

    const validation = validateShapeProgram(raw);
    if (!validation.ok)
      return reject(
        'SHAPE_INVALID',
        `shapes[${index}]: ${validation.issues[0]}`,
        validation.issues.map((issue) => `shapes/${index}: ${issue}`),
      );
    shapes.push(raw as ShapeProgram);
  }

  // --- placements --------------------------------------------------------

  if (!Array.isArray(answer.placements))
    return reject('WRONG_SHAPE', 'placements is not an array');

  const adjustments: BlueprintAdjustment[] = [];
  const planned = new Map<string, PlannedObject>(
    plan.objects.map((object) => [object.stableId, object]),
  );
  const placed = new Map<string, SemanticObject>();

  for (const [index, raw] of answer.placements.entries()) {
    const where = `placements/${index}`;
    if (!isRecord(raw)) return reject('WRONG_SHAPE', `${where} is not an object`);

    const stableId = raw.stableId;
    if (typeof stableId !== 'string')
      return reject('WRONG_SHAPE', `${where}.stableId is missing`);

    const object = planned.get(stableId);
    if (object === undefined)
      return reject(
        'PLACEMENT_MISMATCH',
        `${where} places ${stableId}, which the brief never named; place the objects you were given and invent none`,
      );
    if (placed.has(stableId))
      return reject('PLACEMENT_MISMATCH', `${where} places ${stableId} a second time`);

    const source = readSource(raw.source);
    if (typeof source === 'string') return reject('WRONG_SHAPE', `${where}.${source}`);

    const targetBounds = clampBounds(raw.targetBounds, `${where}/targetBounds`, adjustments);
    if (targetBounds === null)
      return reject(
        'WRONG_SHAPE',
        `${where}.targetBounds is not a box of two [x,y,z] triples of finite numbers`,
      );

    placed.set(stableId, {
      stableId: object.stableId,
      label: object.label,
      synonyms: [...object.synonyms],
      role: object.role,
      source,
      targetBounds,
      importance: object.importance,
    });
  }

  // Efekt bez geometrie není chyba — obloha, mlha a prach bydlí ve vzhledové
  // vrstvě, ne v kompozici. Vypuštění se ale **přizná**, protože tiché zmizení
  // objektu ze zadání je přesně ta vada, kterou by nikdo neviděl.
  for (const object of plan.objects) {
    if (placed.has(object.stableId)) continue;
    if (object.role === 'effect') {
      adjustments.push({
        path: `objects/${object.stableId}`,
        reason: 'an effect carries no geometry; the look layer renders it',
      });
      continue;
    }
    return reject(
      'PLACEMENT_MISMATCH',
      `${object.stableId} (${object.label}) has no placement, so the world does not contain something the brief asked for`,
    );
  }

  const objects = plan.objects
    .map((object) => placed.get(object.stableId))
    .filter((object): object is SemanticObject => object !== undefined);

  // --- světový graf ------------------------------------------------------

  if (isCopiedWorld(answer.world))
    return reject(
      'EXAMPLE_COPIED',
      'the world graph is one of the two example worlds, verbatim; a copied world is the same puzzle for every request',
    );

  const repaired = repairEmission(answer.world);
  const chain = certifySteps({
    promptId: plan.intent.setting,
    upstream: options.upstream,
    provenance: { stage: COMPILER_STAGE },
    body: repaired.document,
  });
  let step = chain.next();
  while (!step.done) step = chain.next();
  const verdict = step.value;

  if (verdict.body.outcome !== 'CERTIFIED' || verdict.body.doc === null) {
    const rejection = verdict.body.rejection;
    // `detail` zůstává předponovanou větou schválně: čte ji člověk v Inspect
    // zásuvce a porovnává se jí nepohnuté odmítnutí. Fázi si ale odteď nikdo
    // neparsuje zpátky — jede vedle jako pole.
    return reject(
      'WORLD_REJECTED',
      rejection === null
        ? 'the world graph did not certify'
        : `${rejection.stage}: ${rejection.detail}`,
      rejection === null ? [] : rejection.issues,
      rejection === null
        ? undefined
        : { rejection, context: contextFromEmission(repaired.document) },
    );
  }

  // --- obálka ------------------------------------------------------------

  const draft = {
    version: 'worldstream-v1',
    sessionSeed: options.sessionSeed,
    title: plan.intent.setting.slice(0, 120),
    intent: plan.intent,
    world: verdict.body.doc,
    geometry,
    objects,
    shapes,
  };

  const shapeValidation = validateBlueprint(draft);
  if (!shapeValidation.ok)
    return reject('BLUEPRINT_INVALID', shapeValidation.issues[0], shapeValidation.issues);

  const blueprint = blueprintSchema.parse(draft);

  const references = findBlueprintReferenceIssues(blueprint);
  if (references.length > 0)
    return reject(
      'REFERENCE_BROKEN',
      `${references[0].where} ${references[0].detail}`,
      references.map((issue) => `${issue.where}: ${issue.detail}`),
    );

  return {
    ok: true,
    stage: COMPILER_STAGE,
    value: blueprint,
    verdict,
    adjustments,
    repairs: repaired.notes,
  };
}

/** Znovu vystavené, aby volající nemusel sahat do dvou souborů. */
export { buildCompilerRequest };
export type { Grammar, PlannerEmission };
