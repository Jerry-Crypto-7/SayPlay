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
import { SHAPE_NODE_GROUPS, shapeProgramSchema, validateShapeProgram } from '@/shape/schema';
import {
  additionObjectSchema,
  MAX_HERO_SHAPES,
  type AdditionObject,
  type SemanticObject,
  type WorldstreamBlueprint,
} from '@/worldstream/schema';

import { EMISSION_MODEL, type UpstreamRequest } from './prompt';
import { shapeVocabulary } from './shape-vocabulary';
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

/**
 * Co věta se světem dělá. **Věta, která nejmenuje nic, co stojí, je přidání**
 * — od P21 T8 to překládala route (`NO_MATCH` → přidej), od P22 T13 to říká
 * grounding sám, protože přidání s kotvou a přidání bez ní musí být týž druh.
 * Odmítnutí zbývá tam, kde si systém vybírat nemá: dvě stejně dobrá jména,
 * nebo id, které svět nezná.
 */
export type Grounding =
  | { readonly ok: true; readonly kind: 'edit'; readonly target: SemanticObject; readonly matched: string }
  | {
      readonly ok: true;
      readonly kind: 'addition';
      /** Objekt, u kterého má nový stát („under the tree"), nebo `null`, když věta místo nejmenuje. */
      readonly anchor: SemanticObject | null;
    }
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

interface Hit {
  readonly object: SemanticObject;
  readonly matched: string;
}

/** Objekty, které text jmenuje, nejdelším jménem napřed. */
function hitsIn(text: string, objects: readonly SemanticObject[]): readonly Hit[] {
  return objects
    .map((object) => {
      const matched = namesOf(object)
        .filter((name) => mentions(text, name))
        .sort((a, b) => b.length - a.length);
      return { object, matched: matched[0] ?? null };
    })
    .filter((hit): hit is Hit => hit.matched !== null)
    .sort((a, b) => b.matched.length - a.matched.length);
}

/**
 * Předložky místa, delší napřed, aby „in front of" nevyhrálo jako „in".
 * Věta tvaru `<nová věc> under <existující>` staví, nemění: objekt za
 * předložkou je kotva, ne cíl (P22 T13). Živý běh 19. 9. 2026 poslal
 * „A wooden bench under the tree" jako úpravu stromu a model správně
 * odpověděl, že úprava nový objekt založit neumí.
 */
const PLACEMENT =
  /\b(?:in front of|on top of|next to|underneath|under|beneath|beside|behind|above|near|against|inside|by|at|on|in)\b/g;

/**
 * Kus věty před předložkou zakládá věc: začíná slovesem přidání, nebo nese
 * neurčitý člen. „make the tree taller on the outside" nemá ani jedno — a má
 * strom před předložkou, což rozhodne ještě dřív.
 */
const NEW_THING =
  /^\s*(?:please\s+)?(?:add|put|place|drop|build|create|spawn|include|hang|set|stand|plant|grow|carve|attach|mount|lean|install|leave|lay)\b|\b(?:a|an|another|some|one|two|three|several|many|more|new)\b/;

/**
 * Který objekt ta věta míní — nebo že žádný a věta staví.
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
      : { ok: true, kind: 'edit', target: named, matched: named.stableId };
  }

  const text = ` ${normalize(sentence)} `;
  const hits = hitsIn(text, objects);
  if (hits.length === 0) return { ok: true, kind: 'addition', anchor: null };

  // Striktně nejdelší, ne „první po seřazení". Shoda stejné délky u dvou objektů
  // je nerozhodnutá věta — u cíle se nabízejí oba, u kotvy se raději nekotví.
  const strictlyLongest = (found: readonly Hit[]): Hit | null =>
    found.length > 1 && found[0].matched.length === found[1].matched.length ? null : found[0];

  // Věta o umístění: před předložkou nová věc a žádný stojící objekt, za ní
  // kotva. Stojící objekt před předložkou znamená, že se mění on — a stojí
  // pak před každou další předložkou, takže dál se nehledá.
  for (const match of text.matchAll(PLACEMENT)) {
    const before = `${text.slice(0, match.index)} `;
    if (hitsIn(before, objects).length > 0) break;
    if (!NEW_THING.test(before)) continue;
    const anchors = hitsIn(` ${text.slice(match.index + match[0].length)}`, objects);
    if (anchors.length > 0) return { ok: true, kind: 'addition', anchor: strictlyLongest(anchors)?.object ?? null };
  }

  const target = strictlyLongest(hits);
  if (target === null) {
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

  return { ok: true, kind: 'edit', target: target.object, matched: target.matched };
}

/* ------------------------------------------------------------------ *
 * Emise.
 * ------------------------------------------------------------------ */

type HeroShape = WorldstreamBlueprint['shapes'][number];

/**
 * **Nový objekt, který věta zakládá** (P21 T8).
 *
 * Objekt a jeho tvar přicházejí spolu a spolu se i commitnou: `object.source`
 * ukazuje na `shape.shapeId` a `shape.stableId` zpátky na objekt. Ten
 * oboustranný odkaz je dosazený při čtení, ne napsaný modelem — viz
 * `additionObjectSchema`.
 */
export interface Addition {
  readonly object: SemanticObject;
  readonly shape: HeroShape;
}

export interface RefinePlan {
  /** Cíl věty — nebo u `addition` id objektu, který věta zakládá. */
  readonly stableId: string;
  /** Jedna věta pro člověka: co se stane. Jde do preview, ne do dokumentu. */
  readonly summary: string;
  /** Nová podoba hrdinského tvaru, nebo `null`, když se tvar nemění. */
  readonly shape: HeroShape | null;
  /** Operace do `/sim` — pravidla, entity, stav. */
  readonly behavior: readonly Operation[];
  /** Operace do `/look` — paleta, materiály, atmosféra. */
  readonly appearance: readonly Operation[];
  /**
   * Objekt, který ve světě nebyl a věta ho zakládá — nebo `null`, když věta
   * mění něco, co už stojí. **`shape` je u přidání vždycky `null`:** nový tvar
   * jede tady, aby výměna podoby existujícího objektu (revize, meshing,
   * srovnání dvou budoucností) zůstala tím jediným, čím byla.
   */
  readonly addition: Addition | null;
}

export type RefineRejection =
  | 'NOT_AN_OBJECT'
  | 'WRONG_SHAPE'
  | 'WORLD_DOC_RETURNED'
  | 'WRONG_TARGET'
  | 'WRONG_PART'
  | 'SHAPE_INVALID'
  | 'NO_SHAPE_SOURCE'
  | 'EMPTY_CHANGE'
  /** Nový objekt nesplnil schéma — chybí popisek, kvádr, role. */
  | 'OBJECT_INVALID'
  /** Id nového objektu už ve světě někdo nese: objekt, entita, tvar nebo socket. */
  | 'IDENTITY_TAKEN'
  /** Svět už nese tolik hrdinských tvarů, kolik rozpočet meshování unese. */
  | 'SHAPE_BUDGET'
  /** Přidání nese víc než jednu entitu nebo víc než jedno pravidlo (P21 T9: jedna věta = jeden kus). */
  | 'TOO_MANY_PIECES';

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

/** Abeceda uzlů tvaru jako jedna věta — táž tabulka, kterou čte `shapeVocabulary()`. */
const SHAPE_KIND_ALPHABET = Object.values(SHAPE_NODE_GROUPS).flat().join(', ');

/**
 * Detail odmítnutí tvaru. **Uzel mimo abecedu jmenuje to, co model napsal**,
 * ne jen to, co se čekalo: živý běh 19. 9. 2026 (`evals/worldstream/conversation.json`)
 * odmítl dva ze čtyř kusů na `nodes[0].kind`, a z detailu se nedalo poznat,
 * jestli model tabulku přehlédl, nebo si vymyslel synonymum. Ostatní vady
 * nesou první nález validace beze změny.
 */
function shapeInvalidDetail(shape: unknown, issues: readonly string[]): string {
  const first = issues[0];
  const at = /^schema:\/nodes\/(\d+)\/kind:/.exec(first);
  if (at === null) return first;
  const nodes = (shape as { readonly nodes?: readonly unknown[] }).nodes ?? [];
  const kind = (nodes[Number(at[1])] as { readonly kind?: unknown } | undefined)?.kind;
  return `nodes[${at[1]}].kind ${JSON.stringify(kind)} is not a shape node; allowed kinds: ${SHAPE_KIND_ALPHABET}`;
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
    if (!validation.ok) return { ok: false, reason: 'SHAPE_INVALID', detail: shapeInvalidDetail(body.shape, validation.issues) };

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
    value: { stableId: target.stableId, summary: summary.trim(), shape, behavior, appearance, addition: null },
  };
}

/* ------------------------------------------------------------------ *
 * Založení nového objektu (P21 T8).
 * ------------------------------------------------------------------ */

/**
 * Všechna jména, která už ve světě někdo nese. Nový objekt nesmí nést žádné
 * z nich — a to napříč tabulkami, ne jen mezi objekty: `stableId` je zároveň
 * klíč entity v `sim`, klíč registru podob a `data-line-id` v DOM, takže
 * shoda s existujícím tvarem nebo socketem by se projevila jinde než tam, kde
 * by ji kdo hledal.
 */
export function takenIdentities(blueprint: WorldstreamBlueprint): ReadonlySet<string> {
  const sim = blueprint.world.sim as { readonly entities?: unknown; readonly sockets?: unknown };
  const keysOf = (table: unknown): string[] =>
    table !== null && typeof table === 'object' && !Array.isArray(table) ? Object.keys(table) : [];
  return new Set([
    ...blueprint.objects.map((object) => object.stableId),
    ...blueprint.shapes.map((shape) => shape.shapeId),
    ...blueprint.shapes.map((shape) => shape.stableId),
    ...keysOf(sim.entities),
    ...keysOf(sim.sockets),
  ]);
}

/**
 * Přečte odpověď modelu jako založení nového objektu, nebo řekne proč ne.
 *
 * Táž pravidla jako u `readRefineEmission`, plus tři, která výměna nemá:
 * objekt musí projít schématem, jeho id nesmí ve světě nikdo nést a tvarů
 * nesmí být víc, než kolik unese rozpočet meshování. **`appearance` tu není
 * vůbec** — nový objekt vzhled nemění a přijmout pole, které by se stejně
 * odmítlo (`hasUnsupportedAppearance`), by jen posunulo odmítnutí o kolo dál.
 *
 * Co se tady **nesoudí**, je dosah operací v `behavior`: jestli sáhly jen na
 * nový objekt, rozhoduje diff stavu v `src/patch/scope.ts` nad skutečným
 * dokumentem, na preview i na commitu. Číst to z cest operací by byla druhá
 * brána, a slabší — `replace /sim` má cestu, která nic nezakazuje.
 */
export function readAdditionEmission(value: unknown, blueprint: WorldstreamBlueprint): RefineResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'NOT_AN_OBJECT', detail: 'the answer is not a JSON object' };

  const body = value as Record<string, unknown>;

  const worldDocFields = WORLD_DOC_FIELDS.filter((field) => field in body);
  if (worldDocFields.length > 0)
    return {
      ok: false,
      reason: 'WORLD_DOC_RETURNED',
      detail: `the answer carries world graph fields (${worldDocFields.join(', ')}); this stage answers with one new object, not a world`,
    };

  const summary = body.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0)
    return { ok: false, reason: 'WRONG_SHAPE', detail: 'summary is missing or empty' };

  if (body.shape === null || body.shape === undefined)
    return { ok: false, reason: 'WRONG_SHAPE', detail: 'a new object needs a shape, and the answer has none' };

  const parsedObject = additionObjectSchema.safeParse(body.object);
  if (!parsedObject.success)
    return {
      ok: false,
      reason: 'OBJECT_INVALID',
      detail: `object/${parsedObject.error.issues[0].path.join('/')}: ${parsedObject.error.issues[0].message}`,
    };
  const object: AdditionObject = parsedObject.data;

  if (blueprint.shapes.length >= MAX_HERO_SHAPES)
    return {
      ok: false,
      reason: 'SHAPE_BUDGET',
      detail: `this world already carries ${String(MAX_HERO_SHAPES)} hero shapes, which is all the mesh budget allows`,
    };

  const validation = validateShapeProgram(body.shape);
  if (!validation.ok) return { ok: false, reason: 'SHAPE_INVALID', detail: shapeInvalidDetail(body.shape, validation.issues) };
  const shape = shapeProgramSchema.parse(body.shape);

  if (shape.stableId !== object.stableId)
    return {
      ok: false,
      reason: 'WRONG_TARGET',
      detail: `the shape belongs to ${shape.stableId}, but the new object is ${object.stableId}`,
    };

  const taken = takenIdentities(blueprint);
  for (const name of [object.stableId, shape.shapeId])
    if (taken.has(name))
      return {
        ok: false,
        reason: 'IDENTITY_TAKEN',
        detail: `${name} is already used in this world; a new object needs a name nothing else carries`,
      };
  if (shape.shapeId === object.stableId)
    return {
      ok: false,
      reason: 'IDENTITY_TAKEN',
      detail: `${object.stableId} names both the object and its shape; the shape needs its own name`,
    };

  const behavior = readOperations(body.behavior ?? [], 'behavior');
  if (typeof behavior === 'string')
    return {
      ok: false,
      reason: Array.isArray(body.behavior) ? 'WRONG_PART' : 'WRONG_SHAPE',
      detail: behavior,
    };

  // **Jedna věta = jeden kus** (P21 T9). Věta už přišla rozřezaná
  // (`planIncrement`), takže druhá entita nebo druhé pravidlo v odpovědi je
  // model, který si přibral, co nikdo neobjednal — a dosah ani schéma to
  // nechytí, protože obojí je nové a nesahá na nic cizího.
  const pieces = countPieces(behavior, blueprint.world.sim);
  if (pieces.entities > 1 || pieces.rules > 1)
    return {
      ok: false,
      reason: 'TOO_MANY_PIECES',
      detail: `${String(pieces.entities)} entities and ${String(pieces.rules)} rules; one sentence adds ONE object and at most ONE rule`,
    };

  return {
    ok: true,
    stage: REFINER_STAGE,
    value: {
      stableId: object.stableId,
      summary: summary.trim(),
      shape: null,
      behavior,
      appearance: [],
      addition: { object: { ...object, source: { kind: 'shape', shapeId: shape.shapeId } }, shape },
    },
  };
}

/**
 * Kolik entit a pravidel operace přidání zakládají. Cesta rozhoduje, `op` soudí
 * router. Zápis celé tabulky (`/sim/rules` s objektem) počítá každý klíč, který
 * ve světě ještě nebyl — jinak by dvě pravidla prošla stropem v jedné operaci,
 * protože brána dosahu vidí jen čerstvé listy a ty jí nevadí.
 */
function countPieces(operations: readonly Operation[], sim: unknown): { readonly entities: number; readonly rules: number } {
  const tables = sim as { readonly entities?: unknown; readonly rules?: unknown };
  // Množiny, ne součty: týž klíč zapsaný dvakrát (po jednom a pak v celé
  // tabulce) je pořád jeden kus (druhá revize 19. 9. 2026).
  const fresh = { entities: new Set<string>(), rules: new Set<string>() };
  const collect = (collection: 'entities' | 'rules', written: unknown): void => {
    if (written === null || typeof written !== 'object' || Array.isArray(written)) return;
    const existing = tables[collection];
    const known = existing !== null && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
    for (const key of Object.keys(written)) if (!Object.hasOwn(known, key)) fresh[collection].add(key);
  };
  for (const operation of operations) {
    const [root, collection, name, ...rest] = pointerTokens(operation.path);
    if (root !== 'sim' || rest.length > 0) continue;
    const written = 'value' in operation ? operation.value : null;
    // Přepis celého `/sim` (nález revize 19. 9. 2026): tabulky jsou uvnitř hodnoty
    // a čerstvé klíče se počítají stejně, jako by přišly po jedné.
    if (collection === undefined) {
      const doc = written as { readonly entities?: unknown; readonly rules?: unknown } | null;
      collect('entities', doc?.entities);
      collect('rules', doc?.rules);
      continue;
    }
    if (collection !== 'entities' && collection !== 'rules') continue;
    if (name !== undefined) {
      fresh[collection].add(name);
      continue;
    }
    collect(collection, written);
  }
  return { entities: fresh.entities.size, rules: fresh.rules.size };
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

/**
 * Pole odpovědi, když věta **zakládá** objekt. Čte to `requestStage()` stejně
 * jako `REFINE_ANSWER_FIELDS`, a ze stejného důvodu se seznam do systémové
 * věty neopisuje ručně.
 */
export const ADDITION_ANSWER_FIELDS = ['summary', 'object', 'shape', 'behavior'] as const;

/**
 * Co model o světě uvidí, když do něj přidává. **Víc než u výměny**: nový
 * objekt musí někam stát, takže model potřebuje kvádry všeho, co už stojí,
 * a jména, která už nesmí použít. Program kompozice zůstává mimo — místo
 * v prostoru říkají kvádry, ne řádky, ze kterých vznikly.
 */
function additionBrief(blueprint: WorldstreamBlueprint): string {
  return JSON.stringify(
    {
      objects: blueprint.objects.map((object) => ({
        stableId: object.stableId,
        label: object.label,
        role: object.role,
        targetBounds: object.targetBounds,
      })),
      takenNames: [...takenIdentities(blueprint)].sort(),
      sim: blueprint.world.sim,
    },
    null,
    2,
  );
}

/**
 * @param anchor objekt, u kterého má nový stát („a bench under the tree"), nebo
 *   `null`. Model dostane jeho id a kvádr zvlášť, ne jen v seznamu objektů:
 *   věta říká „the tree" a model by si jinak vybíral, který objekt to je,
 *   podruhé a jinak než grounding.
 */
export function buildAdditionRequest(
  sentence: string,
  blueprint: WorldstreamBlueprint,
  anchor: SemanticObject | null,
): UpstreamRequest {
  const system = [
    'A world is already running and a person has just asked for something that is not in it yet.',
    'You answer with ONE new object and nothing else: ONE object and at most ONE rule for it. Their',
    'sentence names one thing; if it seems to ask for two, answer with the first only. You never',
    'rewrite the world and you never touch an object that already stands in it.',
    '',
    'Answer with a single JSON object whose top-level fields are exactly:',
    `${ADDITION_ANSWER_FIELDS.join(', ')}.`,
    '',
    'summary is ONE sentence, written for the person who asked, saying what will appear and where.',
    'They read it before anything happens and decide whether to go ahead.',
    '',
    'object is { stableId, label, synonyms, role, importance, targetBounds }. stableId is camelCase,',
    'unique, and NOT one of takenNames in the request. label is what a person would call it; synonyms',
    'are other words they might use. role is one of architecture, hero, prop, terrain, effect.',
    'importance is 0 to 3. targetBounds { min, max } is where it stands, in the same WORLD',
    'coordinates as the objects in the request — put it on the ground, next to what it belongs to,',
    'and do not overlap an existing object.',
    '',
    'shape is the ShapeProgram that draws it. Its stableId is the object stableId; its shapeId is',
    'its own name, also not in takenNames. Its targetBounds are in SHAPE space, centred on the origin.',
    // Živý běh 19. 9. 2026: dva kusy ze čtyř přišly s `nodes[0].kind` mimo
    // abecedu, ačkoli tabulka o třicet řádků níž ji celou vypisuje. Hypotéza
    // z T11 je, že model tabulku přehlédl; tahle věta stojí přímo u pole a
    // T22 změří, jestli to stačí.
    `Every node's kind is one of: ${SHAPE_KIND_ALPHABET}. Nothing else is a node — no pyramid,`,
    'no wedge, no mesh; build such things from these.',
    '',
    shapeVocabulary(),
    '',
    'behavior is a list of RFC 6902 operations that give the new object a place in the simulation,',
    'and it may be empty. Every operation is "add". Allowed paths, and only these:',
    '  /sim/entities/<stableId>          the new object as an entity: { role, socket, state }',
    '  /sim/sockets/<newSocket>          a NEW grid cell [x, y] inside sim.layout, for that entity',
    '  /sim/collisionAabb/<stableId>     its footprint [x, y, w, h] in grid cells',
    '  /sim/rules/<newRule>              a NEW rule, in the same form as the rules in the request',
    'Never write to an existing entity, socket, rule, state or flag. Never replace, remove or move',
    'anything. The new rule may react to existing objects and act on them at runtime, but it never',
    'decides the game: an action of kind win or lose gets the whole answer rejected. Every object',
    'you do not name keeps its shape, its state and its place.',
    '',
    'Fields like sim, look or irVersion at the top level belong to a different stage, and an answer',
    'carrying them is rejected whole.',
  ].join('\n');

  const user = [
    'This is the world as it stands right now. Add to it, do not rewrite it:',
    additionBrief(blueprint),
    '',
    ...(anchor === null
      ? []
      : [
          `The new object stands next to this object: ${anchor.stableId} (${anchor.label}), whose targetBounds are ${JSON.stringify(anchor.targetBounds)}.`,
          'Place it where the sentence says, touching or beside those bounds, and leave that object exactly as it is.',
          '',
        ]),
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
  /**
   * Cíl, na kterém se `groundTarget` shodl — tahle funkce už negrounduje.
   * **`null` znamená, že věta ve světě cíl nemá a zakládá nový objekt**
   * (P21 T8): grounding vrátil `NO_MATCH` a volající se rozhodl přidávat,
   * ne nabízet kandidáty.
   */
  readonly target: SemanticObject | null;
  /** U přidání objekt, u kterého má nový stát (P22 T13); u úpravy se nečte. */
  readonly anchor?: SemanticObject | null;
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
  const { target } = input;
  const request =
    target === null
      ? buildAdditionRequest(input.prompt, input.blueprint, input.anchor ?? null)
      : buildRefineRequest(input.prompt, input.blueprint, target);

  let answer: unknown;
  try {
    answer = await observePhaseAsync(input.observePhase, 'edit-emitter', () => input.emit(request));
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

  const read = observePhase(input.observePhase, 'edit-validation', () =>
    target === null ? readAdditionEmission(answer, input.blueprint) : readRefineEmission(answer, target),
  );
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
