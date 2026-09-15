/**
 * **Planner (P13 T10): věta → sémantický záměr.**
 *
 * První ze dvou modelových fází (design book §10.1). Planner odpovídá na
 * otázku „o jakém místě to je", **nikdy** na otázku „jak to nakreslit".
 * Geometrii píše compiler v T11 a dostane k tomu tenhle výstup, ne původní větu.
 *
 * ## Proč planner nesmí vidět slovník geometrie
 *
 * Kdyby systémová zpráva jmenovala `GeomProgram`, mřížku nebo uzly tvaru, model
 * by začal geometrii navrhovat rovnou — a fáze by splynuly do jednoho obřího
 * dokumentu, což je přesně to, co §10.1 rozděluje. Sémantická shoda se pak už
 * nedá hodnotit bez spuštění Three.js. Hlídá to `containsGeometryVocabulary()`
 * a sada nad ním; není to stylistická preference, je to hranice fází.
 *
 * ## Tři způsoby, jak strukturálně platný plán může být špatná odpověď
 *
 * 1. **Vrátí celý `WorldDoc`.** Model zná starou emisi z `./prompt.ts` a je to
 *    jeho nejsilnější zvyk. Plán s poli `sim` / `look` / `irVersion` se odmítá
 *    jmenovitě, aby chybová hláška řekla, co se stalo.
 * 2. **Opíše ukázku.** Naměřeno v P12 u malého modelu: kartu, páku a bránu
 *    z ukázky opsal i pro zenovou zahradu. Kopie je strukturálně bezvadná.
 * 3. **Vydá prázdné `unsupported` a tváří se, že umí všechno.** Prázdný seznam
 *    povolený je — občas je pravda — ale musí být rozhodnutím, ne chybějícím
 *    polem. Proto se chybějící pole odmítá a prázdné pole projde.
 */

import { EMISSION_MODEL, type UpstreamRequest } from './prompt';
import { EXAMPLE_ONLY_IDENTIFIERS, EXAMPLE_PLAN, ROLE_HINTS } from './worldstream-examples';

/**
 * Značka fáze. Píše se do provenance, aby šlo poznat plán od staré emise —
 * obojí je JSON od modelu a v logu by se jinak slilo.
 */
export const PLANNER_STAGE = 'worldstream-intent';

export const INTENT_ROLES = ['architecture', 'hero', 'prop', 'terrain', 'effect'] as const;

export type IntentRole = (typeof INTENT_ROLES)[number];

/** Strojově čitelný rozklad věty (design book §9.3). */
export interface IntentSummary {
  readonly setting: string;
  readonly mood: string;
  /** Jedna věta o tom, jak je prostor uspořádaný. */
  readonly spatialThesis: string;
  readonly actors: readonly string[];
  readonly heroObjects: readonly string[];
  readonly interactions: readonly string[];
  /** Jmenovitě to, co systém abstrahoval. Není to omluva, jde to do UI. */
  readonly unsupported: readonly string[];
}

/**
 * Sémantická polovina `SemanticObject` (§9.4).
 *
 * `source`, `interactionSockets` a `targetBounds` tu schválně **nejsou**:
 * planner o geometrii nic neví, takže by je vymyslel. Doplní je compiler v T11,
 * až bude čím — a jejich nepřítomnost je to, co tuhle hranici drží.
 */
export interface PlannedObject {
  readonly stableId: string;
  readonly label: string;
  /** Pro přirozený odkaz ve druhé větě („zvětši tu kopuli"). */
  readonly synonyms: readonly string[];
  readonly role: IntentRole;
  readonly importance: 0 | 1 | 2 | 3;
}

export interface PlannerEmission {
  readonly intent: IntentSummary;
  readonly objects: readonly PlannedObject[];
}

export type PlannerRejection =
  /** Odpověď není objekt, nebo je to pole. */
  | 'NOT_AN_OBJECT'
  /** Chybí pole, nebo má špatný typ. */
  | 'WRONG_SHAPE'
  /** Model vrátil starou emisi místo plánu. */
  | 'WORLD_DOC_RETURNED'
  /** Doslovná kopie ukázky, nebo její jména v cizí větě. */
  | 'EXAMPLE_COPIED'
  /** Plán bez objektů není plán. */
  | 'EMPTY_PLAN';

export type PlannerResult =
  | { readonly ok: true; readonly value: PlannerEmission; readonly stage: typeof PLANNER_STAGE }
  | { readonly ok: false; readonly reason: PlannerRejection; readonly detail: string };

/**
 * Slova, kterými se mluví o geometrii. Systémová zpráva plannera žádné z nich
 * nesmí obsahovat — jinak si fáze lezou do zelí (viz hlavička souboru).
 *
 * Seznam je uzavřený a soudí se nad hranicemi slov. `box` je tu schválně jako
 * celé slovo: „a box of matches" je legitimní věta uživatele, ale v **naší**
 * systémové zprávě nemá co dělat.
 */
export const GEOMETRY_VOCABULARY: readonly string[] = [
  'geomprogram',
  'shapeprogram',
  'mesh',
  'vertex',
  'vertices',
  'triangle',
  'polygon',
  'sdf',
  'voxel',
  'grid',
  'primitive',
  'extrude',
  'revolve',
  'box',
  'cylinder',
  'sphere',
  'torus',
];

/** Vrátí slova z `GEOMETRY_VOCABULARY`, která v textu skutečně stojí. */
export function containsGeometryVocabulary(text: string): string[] {
  const lowered = text.toLowerCase();
  return GEOMETRY_VOCABULARY.filter((word) => new RegExp(`\\b${word}\\b`).test(lowered));
}

/** Pole staré emise. Jejich přítomnost znamená, že model odpověděl špatnou fází. */
const WORLD_DOC_FIELDS = ['irVersion', 'simRevision', 'lookRevision', 'sim', 'look'];

/**
 * Pole, která tahle fáze v odpovědi žádá.
 *
 * Je to konstanta, a ne text v promptu, protože podle **týchž** polí se
 * o kus dál pozná, který ze dvou požadavků právě přišel
 * (`requestStage()` ve `worldstream-prompt.ts`). Kdyby se seznam psal na
 * dvou místech, rozešel by se a rozlišovač by tiše přestal rozlišovat —
 * sklad uvařených světů by pak na compiler požadavek vydal plán.
 */
export const PLANNER_ANSWER_FIELDS = ['intent', 'objects'] as const;

export function buildIntentRequest(prompt: string): UpstreamRequest {
  const system = [
    'You read one sentence describing a place and answer with what that place IS.',
    'You never describe how to draw it. Another stage does that, and it is given your answer, not the sentence.',
    '',
    'Answer with a single JSON object and nothing else. Its top-level fields are exactly:',
    `${PLANNER_ANSWER_FIELDS.join(', ')}.`,
    '',
    'intent carries: setting, mood, spatialThesis, actors, heroObjects, interactions, unsupported.',
    'spatialThesis is ONE sentence about how the space is arranged — what is where, and what that',
    'arrangement makes true. "A big hall" is not a thesis. "One continuous helix wraps a hollow core,',
    'so the path up and the storage are the same surface" is.',
    '',
    'unsupported is the list of abstractions you made, named. It is shown to the person who wrote the',
    'sentence, so write it for them: "the water is a surface, not a fluid you can displace" tells them',
    'something. "some limitations apply" tells them nothing and is not an acceptable entry. If the',
    'sentence really needed nothing abstracted away, leave it empty rather than inventing an excuse.',
    '',
    'objects is the list of things in the place. Each one carries:',
    'stableId (camelCase, unique, no spaces), label (how a person would say it), synonyms,',
    'role, importance.',
    '',
    `role is exactly one of: ${INTENT_ROLES.join(', ')}.`,
    ...INTENT_ROLES.map((role) => `  ${role}: ${ROLE_HINTS[role]}`),
    '',
    'synonyms matter more than they look. Later the person will say "make the dome taller" and we have',
    'to know which object they mean. List every name they might reasonably use, including the bare noun.',
    '',
    'importance is 0 to 3. 3 is the thing the sentence is about and cannot be missing. 0 is atmosphere',
    'that can be dropped on a weak machine without the sentence becoming untrue.',
    '',
    'You do NOT write sizes, positions, materials, colours, or anything a renderer would read.',
    'You do NOT write a world graph. Fields like sim, look or irVersion belong to a different stage and',
    'an answer carrying them is rejected whole.',
    '',
    'An example answer, for a sentence unrelated to yours. Copy the SHAPE and nothing else:',
    JSON.stringify(EXAMPLE_PLAN, null, 2),
  ].join('\n');

  // Táž doktrína jako u staré emise: zákaz jmenuje obsah ukázky přímo a zadání
  // stojí až za ním. Kopie ukázky je strukturálně platná, a proto ji nechytne
  // nic než jméno.
  const user = [
    'REQUEST-SPECIFIC CONTENT is authoritative. The example above demonstrates shape only.',
    'Its observatory-on-ice scenario is semantically wrong for any unrelated request.',
    `Do not reuse these example-only names unless the request itself calls for them: ${EXAMPLE_ONLY_IDENTIFIERS.join(', ')}.`,
    'A structurally valid plan that does not name the request-specific things is an invalid answer.',
    '',
    'Say what this place is:',
    prompt,
  ].join('\n');

  return { model: EMISSION_MODEL, system, user };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Přečte `intent` jako `IntentSummary`, nebo vrátí větu o tom, co mu chybí.
 *
 * **Exportované schválně, a je to jediná definice toho kontraktu.** Blueprint
 * (`src/worldstream/schema.ts`) `intent` validuje taky — nese ho dál a musí
 * ustát načtení z disku. Kdyby si na to napsal vlastní zod schéma, byly by to
 * dvě definice jedné vlastnosti a jedna z nich by se dřív nebo později
 * přestala trefovat, aniž by o tom kdokoli věděl.
 */
export function readIntent(value: unknown): IntentSummary | string {
  if (value === null || typeof value !== 'object') return 'intent is not an object';
  const intent = value as Record<string, unknown>;

  for (const field of ['setting', 'mood', 'spatialThesis'])
    if (!nonEmptyString(intent[field])) return `intent.${field} is missing or empty`;

  // `unsupported` je v tomhle seznamu schválně: chybějící pole a prázdné pole
  // jsou dvě různá tvrzení a jen to druhé smí model udělat vědomě.
  for (const field of ['actors', 'heroObjects', 'interactions', 'unsupported'])
    if (!isStringArray(intent[field])) return `intent.${field} is not an array of strings`;

  return {
    setting: intent.setting as string,
    mood: intent.mood as string,
    spatialThesis: intent.spatialThesis as string,
    actors: intent.actors as string[],
    heroObjects: intent.heroObjects as string[],
    interactions: intent.interactions as string[],
    unsupported: intent.unsupported as string[],
  };
}

function readObject(value: unknown, index: number): PlannedObject | string {
  if (value === null || typeof value !== 'object') return `objects[${index}] is not an object`;
  const object = value as Record<string, unknown>;

  for (const field of ['stableId', 'label'])
    if (!nonEmptyString(object[field])) return `objects[${index}].${field} is missing or empty`;

  if (!isStringArray(object.synonyms))
    return `objects[${index}].synonyms is not an array of strings`;
  if (!(INTENT_ROLES as readonly unknown[]).includes(object.role))
    return `objects[${index}].role ${JSON.stringify(object.role)} is not one of ${INTENT_ROLES.join(', ')}`;
  if (
    object.importance !== 0 &&
    object.importance !== 1 &&
    object.importance !== 2 &&
    object.importance !== 3
  )
    return `objects[${index}].importance ${JSON.stringify(object.importance)} is not 0, 1, 2 or 3`;

  return {
    stableId: object.stableId as string,
    label: object.label as string,
    synonyms: object.synonyms,
    role: object.role as IntentRole,
    importance: object.importance,
  };
}

/**
 * Přečte odpověď modelu jako plán, nebo řekne proč ne.
 *
 * **Starý `WorldDoc` se soudí jako první a je to součást kontraktu.** Je to
 * strukturálně platný JSON, takže obecná kontrola tvaru by odpověděla „chybí
 * pole intent" — pravda, která neřekne, co se doopravdy stalo, a sebeoprava by
 * na ni odpověděla dopsáním prázdného `intent` místo změnou fáze.
 *
 * ## Na opsanou ukázku stačí jedna kontrola, ne dvě
 *
 * První verze tohohle souboru porovnávala celou odpověď s ukázkou kanonicky
 * (`canonical(value) === EXAMPLE_CANONICAL`) **a navíc** hlídala půjčená jména.
 * Mutační kontrola 31. 8. 2026 ukázala, že to kanonické porovnání je mrtvé:
 * po jeho odstranění zůstala sada zelená. Důvod je logický, ne náhodný —
 * odpověď kanonicky totožná s ukázkou nutně nese i její `stableId` a `label`,
 * takže ji zachytí kontrola půjčených jmen, která je navíc **přísnější** (chytí
 * i plán, kde je z ukázky jediný objekt). Dvě kontroly na tutéž vlastnost
 * znamenají, že jedna z nich nikdy neselže a nikdo se to nedozví.
 *
 * Drží to test „jméno z ukázky se chytí i v jinak vlastním plánu": kdyby někdo
 * kontrolu jmen zúžil zpět na porovnání celého dokumentu, ten test zčervená.
 */
export function readPlannerEmission(value: unknown): PlannerResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'NOT_AN_OBJECT', detail: 'the answer is not a JSON object' };

  const body = value as Record<string, unknown>;

  const worldDocFields = WORLD_DOC_FIELDS.filter((field) => field in body);
  if (worldDocFields.length > 0)
    return {
      ok: false,
      reason: 'WORLD_DOC_RETURNED',
      detail: `the answer carries world graph fields (${worldDocFields.join(', ')}); this stage answers with intent and objects only`,
    };

  const intent = readIntent(body.intent);
  if (typeof intent === 'string') return { ok: false, reason: 'WRONG_SHAPE', detail: intent };

  if (!Array.isArray(body.objects))
    return { ok: false, reason: 'WRONG_SHAPE', detail: 'objects is not an array' };
  if (body.objects.length === 0)
    return {
      ok: false,
      reason: 'EMPTY_PLAN',
      detail: 'objects is empty; a place with nothing in it is not a plan',
    };

  const objects: PlannedObject[] = [];
  for (const [index, entry] of body.objects.entries()) {
    const object = readObject(entry, index);
    if (typeof object === 'string') return { ok: false, reason: 'WRONG_SHAPE', detail: object };
    objects.push(object);
  }

  const borrowed = objects
    .flatMap((object) => [object.stableId, object.label])
    .filter((name) => EXAMPLE_ONLY_IDENTIFIERS.includes(name));
  if (borrowed.length > 0)
    return {
      ok: false,
      reason: 'EXAMPLE_COPIED',
      detail: `the answer reuses example-only names: ${[...new Set(borrowed)].join(', ')}`,
    };

  return { ok: true, value: { intent, objects }, stage: PLANNER_STAGE };
}
