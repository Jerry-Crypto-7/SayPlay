import { observePhase, observePhaseAsync, type PhaseObserver } from './phase-observer';
/**
 * **Druhá věta (P15 T22): grounded refine.**
 *
 * Design book §4 dějství III a §21. Porotce napíše druhou větu do běžícího
 * světa — *„Turn the bridge into woven roots. It should grow only while all
 * three organs harmonize."* — a systém musí odpovědět na dvě otázky dřív, než
 * cokoli změní: **který objekt to je** a **co přesně se stane**.
 *
 * Tenhle soubor je obě odpovědi a nic víc. Nesahá na relaci, na registr ani na
 * síť; je to čistá vrstva mezi větou a `PendingChange`, kterou pak commitne
 * route. Aplikaci patche dělá **stávající** řetěz (`src/patch/router.ts` →
 * `src/app/api/edit/commit.ts`), který se kvůli tomuhle nemění.
 *
 * ## Grounding: nejdřív jméno, teprve pak model
 *
 * `SemanticObject` nese `stableId`, `label` a `synonyms` právě proto, aby druhá
 * věta trefila objekt bez modelu (§9.4, planner o synonyma prosí jmenovitě).
 * Rozhoduje se tedy **před** placeným voláním: nejasná věta se vrátí jako
 * disambiguace a nestojí nic. Riziková tabulka §24 to jmenuje jako jediný
 * způsob, jak se druhá věta smí splést — nabídkou, ne tichým odhadem.
 *
 * **Nejdelší shoda vyhrává, ale jen když je striktně nejdelší.** Svět, kde stojí
 * `bridge` i `bridge railing`, dostane na větu „raise the bridge railing" obojí;
 * delší jméno je konkrétnější a je to ta správná odpověď. Shoda **stejné** délky
 * u dvou objektů je naopak přesně ten případ, kdy si systém vybírat nemá.
 *
 * ## Fasety jsou pro člověka, dráhu pořád rozhodují cesty
 *
 * Preview dělí změnu na `shape` / `behavior` / `appearance`, protože to je to,
 * co §4 ukazuje porotci před commitem. **Není to štítek, podle kterého by se
 * routovalo** — `DESIGN-BOOK.md` §7 to zakazuje a `routePatch` se ptá cest.
 * Faseta tady umí jedinou věc: nechat celou odpověď odmítnout, když lže. Operace
 * pod `behavior`, která míří do `/look`, je vadná emise, ne přeřazená operace.
 *
 * Kořen se čte `pointerTokens`, ne `startsWith('/sim')` — `/simRevision` je
 * kořenové pole dokumentu a řetězcové porovnání by ho pustilo dovnitř `sim`.
 * Táž past a týž dekodér jako v routeru.
 */

import type { Operation } from 'rfc6902';

import { pointerTokens } from '@/patch/reject';
import { shapeProgramSchema, validateShapeProgram } from '@/shape/schema';
import type { SemanticObject, WorldstreamBlueprint } from '@/worldstream/schema';

import { EMISSION_MODEL, type UpstreamRequest } from './prompt';
import type { BlueprintEmitter } from './worldstream-repair';

/** Značka fáze do provenance. Třetí modelová fáze vedle plannera a compileru. */
export const REFINER_STAGE = 'worldstream-refine';

/**
 * Kolik previewů si relace drží. Preview zakládá kdokoli s adresou relace,
 * takže neomezená mapa je únik paměti dosažitelný zvenčí — a strop je proto na
 * tom, co se **drží**, ne na tom, kolik se jich smí založit: nový preview
 * vždycky projde a nejstarší vypadne. Osm je nad tím, kolik jich porotce
 * otevře, než jeden z nich commitne.
 */
export const MAX_PENDING_CHANGES = 8;

/* ------------------------------------------------------------------ *
 * Grounding.
 * ------------------------------------------------------------------ */

export type GroundingReason =
  /** Věta nepojmenovala nic, co ve světě stojí. */
  | 'NO_MATCH'
  /** Dvě jména stejné délky, tedy nic, čím se vybrat. */
  | 'AMBIGUOUS'
  /** Klient poslal `stableId`, který v blueprintu není. */
  | 'UNKNOWN_ID';

export interface GroundingCandidate {
  readonly stableId: string;
  readonly label: string;
  /** Jméno, kterým se objekt do věty trefil. `null`, když se netrefil vůbec. */
  readonly matched: string | null;
}

export type Grounding =
  | { readonly ok: true; readonly target: SemanticObject; readonly matched: string }
  | {
      readonly ok: false;
      readonly reason: GroundingReason;
      readonly candidates: readonly GroundingCandidate[];
    };

/**
 * Text srovnaný na porovnatelný tvar: malá písmena, interpunkce na mezery,
 * mezery sražené. Členy se **nezahazují** — „the mast" i „mast" se najdou jako
 * celé slovo uvnitř normalizované věty, takže mazat je znamená jen ztratit
 * délku, podle které se pak vybírá konkrétnější jméno.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `ironMast` → `iron mast`. Model píše id v camelCase, člověk říká slova. */
function spacedId(stableId: string): string {
  return normalize(stableId.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

/** Všechna jména, kterými se na objekt dá ukázat. Duplicity vypadnou. */
function namesOf(object: SemanticObject): readonly string[] {
  const names = [
    spacedId(object.stableId),
    normalize(object.label),
    ...object.synonyms.map(normalize),
  ];
  return [...new Set(names.filter((name) => name.length > 0))];
}

/** Stojí `name` ve větě jako celé slovo? Podřetězec by z „mast" udělal „mastery". */
function mentions(sentence: string, name: string): boolean {
  return sentence.includes(` ${name} `);
}

/**
 * Který objekt ta věta míní.
 *
 * `stableId` od klienta má přednost před textem a je to celý smysl T23: až
 * porotce objekt klikne, o cíli rozhodl on, ne rozpoznávač. Neznámé id se
 * **nedohledává textem** — klient tvrdí něco o světě, který nemá, a tiché
 * přepnutí na jiný objekt je právě ta chyba, které se tenhle soubor vyhýbá.
 */
export function groundTarget(
  sentence: string,
  objects: readonly SemanticObject[],
  stableId?: string,
): Grounding {
  const offer = (): GroundingCandidate[] =>
    objects.map((object) => ({ stableId: object.stableId, label: object.label, matched: null }));

  if (stableId !== undefined) {
    const named = objects.find((object) => object.stableId === stableId);
    return named === undefined
      ? { ok: false, reason: 'UNKNOWN_ID', candidates: offer() }
      : { ok: true, target: named, matched: named.stableId };
  }

  const text = ` ${normalize(sentence)} `;
  const hits = objects
    .map((object) => {
      const matched = namesOf(object)
        .filter((name) => mentions(text, name))
        .sort((a, b) => b.length - a.length);
      return { object, matched: matched[0] ?? null };
    })
    .filter((hit): hit is { object: SemanticObject; matched: string } => hit.matched !== null)
    .sort((a, b) => b.matched.length - a.matched.length);

  if (hits.length === 0) return { ok: false, reason: 'NO_MATCH', candidates: offer() };

  // Striktně nejdelší, ne „první po seřazení". Shoda stejné délky u dvou objektů
  // je nerozhodnutá věta a nabízejí se oba.
  if (hits.length > 1 && hits[0].matched.length === hits[1].matched.length) {
    const tied = hits.filter((hit) => hit.matched.length === hits[0].matched.length);
    return {
      ok: false,
      reason: 'AMBIGUOUS',
      candidates: tied.map((hit) => ({
        stableId: hit.object.stableId,
        label: hit.object.label,
        matched: hit.matched,
      })),
    };
  }

  return { ok: true, target: hits[0].object, matched: hits[0].matched };
}

/* ------------------------------------------------------------------ *
 * Emise.
 * ------------------------------------------------------------------ */

export interface RefinePlan {
  readonly stableId: string;
  /** Jedna věta pro člověka: co se stane. Jde do preview, ne do dokumentu. */
  readonly summary: string;
  /** Nová podoba hrdinského tvaru, nebo `null`, když se tvar nemění. */
  readonly shape: WorldstreamBlueprint['shapes'][number] | null;
  /** Operace do `/sim` — pravidla, entity, stav. */
  readonly behavior: readonly Operation[];
  /** Operace do `/look` — paleta, materiály, atmosféra. */
  readonly appearance: readonly Operation[];
}

export type RefineRejection =
  | 'NOT_AN_OBJECT'
  | 'WRONG_SHAPE'
  | 'WORLD_DOC_RETURNED'
  | 'WRONG_TARGET'
  | 'WRONG_PART'
  | 'SHAPE_INVALID'
  | 'NO_SHAPE_SOURCE'
  | 'EMPTY_CHANGE';

export type RefineResult =
  | { readonly ok: true; readonly value: RefinePlan; readonly stage: typeof REFINER_STAGE }
  | { readonly ok: false; readonly reason: RefineRejection; readonly detail: string };

/** Pole staré emise. Jejich přítomnost znamená, že model odpověděl špatnou fází. */
const WORLD_DOC_FIELDS = ['irVersion', 'simRevision', 'lookRevision', 'sim', 'look'];

/** Do které části dokumentu ta faseta smí psát. */
const FACET_PART = { behavior: 'sim', appearance: 'look' } as const;

type Facet = keyof typeof FACET_PART;

/**
 * **Pravidlo, které druhá věta zakládá nebo přepisuje, dostane `id` z klíče cesty.**
 *
 * Create cesta to dělá od `949e38f` (`repairRules` v `src/model/repair.ts`) a
 * editační cesta to nedělala vůbec, takže `add /sim/rules/lightUp` s tělem bez
 * `id` skončilo terminálně: `introducedRuleKeyFault` (`src/ir/worlddoc.ts`) to
 * přečte jako **nově zavlečenou** vadu, commit route odpoví `REJECTED` — a za
 * commitem žádné opravné kolo není. Porotce tím přišel o zaplacené volání
 * modelu a o možnost změnit zákon, což slibuje design book §4 dějství III.
 *
 * ⚠ **Nález mířil na `src/patch/repair.ts` a tam se to postavit NEMÁ** — změřeno
 * 4. 9. 2026, ne odhadnuto: ten modul má **nula** produkčních importérů (jediní
 * dva jsou `evals/harness/chain.ts` a `evals/harness/live.ts`), takže je to
 * opravář zmrazeného korpusu, ne refine cesty. Oprava tam by na produktu
 * nezměnila nic.
 *
 * **`id` přebíjí i to, co napsal model**, přesně jako na create cestě a ze
 * stejného důvodu: klíč JE pointer, kterým se na pravidlo míří, takže pravidlo
 * s jiným `id` leží v dokumentu a žádný patch ho nenajde. Dvě různá pravidla
 * pro jedno pole by se navíc časem rozešla.
 *
 * **`replace` je tu vedle `add` schválně** — přepsat celé tělo pravidla bez
 * `id` je táž vada pod jiným jménem operace a odmítla by se toutéž větví.
 * Cesty hlouběji (`…/priority`) sem nepatří: ty `id` nesahají.
 */
function withRuleId(operation: Operation): Operation {
  if (operation.op !== 'add' && operation.op !== 'replace') return operation;

  const tokens = pointerTokens(operation.path);
  if (tokens.length !== 3 || tokens[0] !== 'sim' || tokens[1] !== 'rules') return operation;

  const body = (operation as { readonly value?: unknown }).value;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return operation;

  const key = tokens[2];
  if ((body as { readonly id?: unknown }).id === key) return operation;
  return { ...operation, value: { ...body, id: key } } as Operation;
}

/** Operace fasety, nebo věta o tom, čím se od nich liší. */
function readOperations(value: unknown, facet: Facet): readonly Operation[] | string {
  if (!Array.isArray(value)) return `${facet} is not an array of operations`;

  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object')
      return `${facet}[${index}] is not an operation object`;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== 'string' || !path.startsWith('/'))
      return `${facet}[${index}].path is not a JSON Pointer`;

    // Kořen z rozebraných tokenů, ne z prefixu řetězce. `/simRevision` je
    // kořenové pole dokumentu a `startsWith('/sim')` by ho pustilo do `sim`.
    const [root] = pointerTokens(path);
    if (root !== FACET_PART[facet])
      return `${facet}[${index}] writes to /${root ?? ''}, but this facet only writes to /${FACET_PART[facet]}`;
  }

  // Tvar operace samotné (`op`, `value`, `from`) soudí router a `applyWorldPatch`
  // nad skutečným dokumentem. Duplikovat to sem znamená dvě brány, které se
  // časem rozejdou — táž úvaha, proč `session.apply()` neopisuje bránu meshe.
  //
  // `withRuleId` **není brána, je to dosazení** — nic neodmítá a nic nesoudí,
  // jen dopisuje pole, jehož jediná možná hodnota stojí v cestě té operace.
  return (value as readonly Operation[]).map(withRuleId);
}

/**
 * Přečte odpověď modelu jako plán změny, nebo řekne proč ne.
 *
 * **Cíl se ověřuje proti groundingu, ne proti tomu, co si model myslí.** Model
 * dostane `stableId` v zadání; kdyby směl vrátit jiný, vybral by si sám, který
 * objekt změní — a porotce by v preview viděl jeden objekt a po commitu jiný.
 */
export function readRefineEmission(value: unknown, target: SemanticObject): RefineResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'NOT_AN_OBJECT', detail: 'the answer is not a JSON object' };

  const body = value as Record<string, unknown>;

  const worldDocFields = WORLD_DOC_FIELDS.filter((field) => field in body);
  if (worldDocFields.length > 0)
    return {
      ok: false,
      reason: 'WORLD_DOC_RETURNED',
      detail: `the answer carries world graph fields (${worldDocFields.join(', ')}); this stage answers with a change, not a world`,
    };

  const summary = body.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0)
    return { ok: false, reason: 'WRONG_SHAPE', detail: 'summary is missing or empty' };

  // Chybějící faseta je prázdná faseta; faseta se špatným kořenem je `WRONG_PART`
  // a je to jiná vada než „tohle vůbec není seznam operací". Sebeoprava na ně
  // odpovídá jinak, takže se nesmějí slít do jednoho důvodu.
  const behavior = readOperations(body.behavior ?? [], 'behavior');
  if (typeof behavior === 'string')
    return {
      ok: false,
      reason: Array.isArray(body.behavior) ? 'WRONG_PART' : 'WRONG_SHAPE',
      detail: behavior,
    };

  const appearance = readOperations(body.appearance ?? [], 'appearance');
  if (typeof appearance === 'string')
    return {
      ok: false,
      reason: Array.isArray(body.appearance) ? 'WRONG_PART' : 'WRONG_SHAPE',
      detail: appearance,
    };

  let shape: RefinePlan['shape'] = null;
  if (body.shape !== null && body.shape !== undefined) {
    // **Nová geometrie jen tam, kde hrdinský tvar už stojí.** Objekt složený
    // z kompozice (`source.kind === 'geom'`) by výměnou za tvar změnil i
    // `objects[].source`, tedy oboustranný odkaz, který hlídá
    // `findBlueprintReferenceIssues` — a to je jiná změna než druhá věta.
    if (target.source.kind !== 'shape')
      return {
        ok: false,
        reason: 'NO_SHAPE_SOURCE',
        detail: `${target.stableId} is drawn by the composition, not by a hero shape, so its shape cannot be rewritten`,
      };

    // ⚠ **Druhá věta na `materialIntent` NENARROVNÁVÁ, a je to rozhodnutí —
    // `T14r-refineintent`, 8. 9. 2026.** První věta má `straightenMaterialIntent()`
    // (`worldstream-compiler.ts`) a přiznává ho v `adjustments`; tady takový kanál
    // není: `RefinePlan` nenese `adjustments` ani `repairs`, takže by přepis
    // proběhl **potichu** — a tichý přepis v preview je přesně ta vada, kterou
    // vlna 0 u produktu zavřela. Preview je jediná věc, podle které se člověk
    // rozhoduje, jestli změnu pustit dál.
    //
    // **Místo narovnání se zavřela příčina**, stejně jako u první věty
    // (`T14r-promptalphabet`): systémová zpráva výš teď u `materialIntent`
    // i u role jmenuje abecedu a říká rovnou, že to tady nikdo nepřepíše.
    // Cena, která zůstává, a je vyšší, než tady stálo do 9. 9. 2026 (nález
    // nezávislé revize): **fráze v `materialIntent` nestojí opravné kolo, ale
    // celou druhou větu.** `planChange()` níž žádnou sebeopravu nemá — vlastní
    // docblock to říká nahlas — takže se odmítnutí vrátí porotci a ten musí
    // napsat větu znovu. `repairEmission()` na téhle cestě neběží vůbec, takže
    // totéž platí o roli psané do `behavior`.
    const validation = validateShapeProgram(body.shape);
    if (!validation.ok) return { ok: false, reason: 'SHAPE_INVALID', detail: validation.issues[0] };

    const parsed = shapeProgramSchema.parse(body.shape);
    if (parsed.stableId !== target.stableId)
      return {
        ok: false,
        reason: 'WRONG_TARGET',
        detail: `the shape belongs to ${parsed.stableId}, but the sentence names ${target.stableId}`,
      };
    if (parsed.shapeId !== target.source.shapeId)
      return {
        ok: false,
        reason: 'WRONG_TARGET',
        detail: `the shape is named ${parsed.shapeId}, but ${target.stableId} is drawn by ${target.source.shapeId}`,
      };
    shape = parsed;
  }

  if (shape === null && behavior.length === 0 && appearance.length === 0)
    return {
      ok: false,
      reason: 'EMPTY_CHANGE',
      detail: 'the answer changes no shape, no rule and no material, so there is nothing to preview',
    };

  return {
    ok: true,
    stage: REFINER_STAGE,
    value: { stableId: target.stableId, summary: summary.trim(), shape, behavior, appearance },
  };
}

/* ------------------------------------------------------------------ *
 * Zadání pro model.
 * ------------------------------------------------------------------ */

/**
 * Co model o světě uvidí. **Ne celý blueprint**: `intent` a `geometry` na změnu
 * jednoho objektu nemají vliv a jen by nafoukly požadavek, který má podle §22.1
 * doběhnout do tří sekund.
 */
function worldBrief(blueprint: WorldstreamBlueprint, target: SemanticObject): string {
  const shape = blueprint.shapes.find((program) => program.stableId === target.stableId) ?? null;
  return JSON.stringify(
    {
      objects: blueprint.objects.map((object) => ({
        stableId: object.stableId,
        label: object.label,
        role: object.role,
      })),
      target: { stableId: target.stableId, label: target.label, source: target.source },
      currentShape: shape,
      sim: blueprint.world.sim,
      look: blueprint.world.look,
    },
    null,
    2,
  );
}

/**
 * Pole, která tahle fáze v odpovědi žádá. Důvod je u `PLANNER_ANSWER_FIELDS`.
 *
 * **Čte to i `requestStage()`**, takže se seznam nesmí opsat do systémové věty
 * ručně: sklad uvařených změn (`T35-actsthree4`) pozná refine požadavek jedině
 * podle něj, a dvě kopie téhož seznamu se rozejdou při prvním doplnění fasety.
 */
export const REFINE_ANSWER_FIELDS = ['summary', 'shape', 'behavior', 'appearance'] as const;

export function buildRefineRequest(
  sentence: string,
  blueprint: WorldstreamBlueprint,
  target: SemanticObject,
): UpstreamRequest {
  const system = [
    'A world is already running and a person has just asked for one change to it.',
    'You answer with that change and nothing else. You never rewrite the world.',
    '',
    'Answer with a single JSON object whose top-level fields are exactly:',
    `${REFINE_ANSWER_FIELDS.join(', ')}.`,
    '',
    'summary is ONE sentence, written for the person who asked, saying what will change.',
    'They read it before anything happens and decide whether to go ahead, so write what they will',
    'see: "the bridge becomes woven roots and only grows while all three organs are active".',
    '',
    'shape is a ShapeProgram replacing how the target object is drawn, or null when the change does',
    'not touch its form. Its stableId and shapeId must be exactly the ones given in the request.',
    'Its materialIntent is camelCase with no spaces — a name, never a colour and never a phrase:',
    'brushedSteel, not "brushed steel". Nothing here rewrites it for you.',
    '',
    'behavior is a list of RFC 6902 operations for an A4 comparison using the same recorded inputs.',
    'The entire behavior change must affect exactly ONE existing rule: either its condition OR ONE existing action.',
    'Preserve every rule identity and rule order. Preserve all triggers, event targets, metadata and action count/order.',
    'Within the one existing action, fields may change, including a timer duration. Do not add, delete or reorder actions or rules.',
    'Do not change entities, sockets, initial state, declarations, witness or any other simulation data.',
    'Do not redirect a trigger to another object or add a redundant action to generalize beyond the request.',
    'All behavior paths are rooted at /sim/rules. A condition change and an action change cannot be combined.',
    'A shape-only edit remains supported with behavior: []. If the behavior request cannot fit this contract,',
    'return behavior: [] and explain the unsupported scope in summary; never claim an unsupported change will happen.',
    'appearance MUST be an empty list. This renderer does not support palette, material, lighting',
    'or atmosphere edits under /look; any such operation rejects the entire change, including mixed changes.',
    'Do not pretend that a shape or behavior edit satisfies an appearance-only request.',
    '',
    'The two lists are not labels and they are not interchangeable. An operation under behavior that',
    'writes to /look gets the whole answer rejected. Do not move unsupported appearance into behavior.',
    'Entity motion fields (for example /sim/entities/id/motion with kind sway) are not implemented.',
    'Do not emit or promise them. Use supported simulation rules for behavior; otherwise state the limitation.',
    '',
    'Change the least that makes the sentence true. Every object you do not name keeps its shape, its',
    'state and its place; a change that rewrites the whole world is a wrong answer even when it would',
    'produce a nicer world.',
    '',
    'Fields like sim, look or irVersion at the top level belong to a different stage, and an answer',
    'carrying them is rejected whole.',
  ].join('\n');

  const user = [
    `The person is changing this object: ${target.stableId} (${target.label}).`,
    '',
    'This is the world as it stands right now. Write your operations against it:',
    worldBrief(blueprint, target),
    '',
    'Their sentence:',
    sentence,
  ].join('\n');

  return { model: EMISSION_MODEL, system, user };
}

/* ------------------------------------------------------------------ *
 * Jedno kolo: věta → preview.
 * ------------------------------------------------------------------ */

export interface ChangeInput {
  readonly observePhase?: PhaseObserver;
  readonly prompt: string;
  readonly blueprint: WorldstreamBlueprint;
  /** Cíl, na kterém se `groundTarget` shodl. Tahle funkce už negrounduje. */
  readonly target: SemanticObject;
  readonly emit: BlueprintEmitter;
}

export type ChangeOutcome =
  | { readonly kind: 'planned'; readonly plan: RefinePlan }
  | { readonly kind: 'rejected'; readonly reason: RefineRejection; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string; readonly cause: unknown };

/**
 * Jedno kolo modelu nad **už rozhodnutým** cílem.
 *
 * Grounding tu schválně není. Volající ho musí udělat dřív, protože je zadarmo
 * a rozhoduje o tom, jestli se vůbec má platit: nejasná věta se má vrátit jako
 * nabídka kandidátů, ne jako odpověď modelu na otázku, kterou si systém sám
 * domyslel.
 *
 * **Bez sebeopravy, a je to rozhodnutí, ne mezera:** odmítnutá druhá věta
 * nechává svět přesně tam, kde byl, takže porotce může napsat jinou. Kolo navíc
 * by ho stálo další vteřiny nad rozpočtem §22.1 a nic by nezachraňovalo — na
 * rozdíl od generace, kde bez blueprintu není svět.
 *
 * **Nevyhazuje.** Text výjimky od poskytovatele nese adresu koncového bodu
 * (`sessions.ts`, `SESSION_FAULTS`), takže se sem vrací jako `unavailable`
 * a ven ho pouští až volající — přeložený na veřejnou větu.
 */
export async function planChange(input: ChangeInput): Promise<ChangeOutcome> {
  let answer: unknown;
  try {
    answer = await observePhaseAsync(input.observePhase, 'edit-emitter', () => input.emit(buildRefineRequest(input.prompt, input.blueprint, input.target)));
  } catch (thrown) {
    // `cause` vedle `detail` ze stejného důvodu jako v `worldstream-repair.ts`:
    // odmítnutý strop a mlčící poskytovatel jsou dvě různé věty pro porotce
    // a rozeznat se musí typem, ne textem.
    return {
      kind: 'unavailable',
      detail: thrown instanceof Error ? thrown.message : String(thrown),
      cause: thrown,
    };
  }

  const read = observePhase(input.observePhase, 'edit-validation', () => readRefineEmission(answer, input.target));
  if (!read.ok) return { kind: 'rejected', reason: read.reason, detail: read.detail };

  return { kind: 'planned', plan: read.value };
}

/* ------------------------------------------------------------------ *
 * Preview čekající na commit.
 * ------------------------------------------------------------------ */

/**
 * Revize, proti kterým preview vzniklo — **tři, ne jedna**.
 *
 * `representation` je revize podoby cílového objektu (§9.8) a hlídá závod
 * s meshingem; `sim` a `look` jsou revize dokumentu (§13.1.1) a hlídají závod
 * s jiným patchem. Jedno sdílené číslo by je slilo: výměna podoby jednoho
 * objektu by zneplatnila preview pravidla, které se jí netýká.
 */
export interface ChangeBase {
  readonly representation: number;
  readonly sim: number;
  readonly look: number;
}

export interface PendingChange {
  readonly changeId: string;
  readonly plan: RefinePlan;
  readonly basedOn: ChangeBase;
  /**
   * Co se stalo, když tohle preview commit **prohrálo** — nebo `undefined`,
   * dokud o nic nepřišlo (`T22-rejectreplay`).
   */
  readonly rejectedAt?: RejectedAt;
}

/** Jedna vytknutá vada, tak jak ji commit route vrací volajícímu. */
export interface RejectionNote {
  readonly stage: string;
  readonly reason: string;
  readonly pointer: string;
  readonly detail: string;
}

/**
 * Razítko prohraného commitu.
 *
 * Odmítnuté preview v mapě zůstává schválně (`T22-takeearly`), aby porotce
 * neplatil druhé volání modelu za tutéž větu. Tím ale smí být jen **opakování
 * téhož verdiktu nad týmž světem**: jakmile se svět mezitím pohnul, je druhý
 * pokus rozhodnutí o jiném světě, než jaký člověk viděl. **Všechny tři** čítače dohromady,
 * protože `staleRevision` soudí každý zvlášť a záměrně — tady jde právě
 * o pohyb v části, které se preview netýká.
 *
 * ⚠ **`representation` v razítku je třetí čítač, ne ozdoba** — nález druhého
 * kola nezávislé revize 4. 9. 2026, ověřený spuštěním route. Commit preview,
 * které mění **jen tvar**, nenese jedinou operaci, takže `sim` ani `look` se
 * nehnou a zvedne se právě a jen revize podoby. Bez téhle položky takový retry
 * propadl pod bránu na starší `STALE_REVISION`, které `rejections` nenese —
 * a protože revize podoby je monotónní, důvod byl nečitelný napořád.
 *
 * ⚠ **Verdikt se veze s razítkem, a je to celý nález nezávislé revize
 * 4. 9. 2026.** Bez něj by 409 nad pohnutým světem spolklo jedinou větu, která
 * člověku říká, proč jeho věta neprošla — a u vad, které na světě nezávisí
 * (vada tvaru patche), se ta věta už nemá jak vrátit, protože verdikt se
 * nemůže změnit.
 */
export interface RejectedAt {
  readonly sim: number;
  readonly look: number;
  /** Revize podoby **toho objektu**, kterého se preview týká. */
  readonly representation: number;
  readonly rejections: readonly RejectionNote[];
}
