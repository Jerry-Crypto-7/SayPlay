/**
 * Režisér (P23-B T7): věta → `GameSpecV1`, hráč hraje hned.
 *
 * Pořadí je smysl celé vrstvy: **návrh ze slov jde ven synchronně** přes
 * `onDraft` ještě před prvním `await`, teprve pak cache, model, kritik a
 * opravy. Model píše jen GameSpec, odpověď čte `readDirectorAnswer`, blokující
 * nálezy kritika se nejdřív opravují z tabulky (`repairDeterministically`),
 * teprve pak nejvýš `maxRepairRounds` modelových kol RFC 6902. Přijatý spec se
 * uloží do cache; **cokoli jiného skončí návrhem** s `fallbackReason`, nikdy
 * výjimkou – návrh existuje vždy, takže větev `ok:false` kontraktu tady nemá
 * kdy nastat (zapsáno v `docs/play/CONTRACT-CHANGES.md`).
 *
 * `MALFORMED` = odpověď se nedala přečíst ani deterministicky opravit (model
 * odpověděl něčím jiným než GameSpec); modelová kola nad ní nemají z čeho
 * záplatovat. `UNREPAIRED` = spec se přečetl, ale blokující nálezy přežily i
 * poslední kolo. `MODEL_UNAVAILABLE` = větev nevrátila odpověď, v prvním
 * volání nebo v opravném kole.
 */

import type { GenerationBranch } from '@/server/pipeline';

import type { DirectorResult, FallbackReason } from '../contracts';
import { draftGameSpecWithMeta } from '../draft';
import { readBeforeDraft, readerEnabled } from '../read/client';
import type { GameSpecV1 } from '../spec';

import type { DirectorCache } from './cache';
import { directorKey } from './cache';
import { COMPACT_PROMPT_VERSION, buildCompactRequest, composeCompact } from './compact';
import { type CriticIssue, blockingIssues, critique, ruleInvalidIssues, unprovedVerbs, verbIssues } from './critic';
import { DIRECTOR_PROMPT_VERSION, buildDirectorRequest } from './prompt';
import { readDirectorAnswer, unwrapAnswer } from './read';
import { EXAMPLES_VERSION } from './retrieval';
import { MAX_REPAIR_ROUNDS, type RepairIssue, applyRepairAnswer, buildRepairRequest, repairDeterministically } from './repair';

export type { FallbackReason } from '../contracts';

/** Rozšíření `DirectorResult` – přiřaditelné do kontraktu, s tím, co obálka a měření potřebují navíc. */
/**
 * Proč režie skončila návrhem (P26 T3): kde to spadlo, přesný důvod a co model
 * poslal. Jde do záznamu selhání a do logu, nikdy hráči.
 */
export interface DirectorFailure {
  readonly stage: 'model' | 'read' | 'critic';
  readonly reason: string;
  readonly detail: string;
  readonly raw: unknown;
}

export type DirectedGame = DirectorResult & {
  /** Jen u návratu na návrh. */
  readonly failure?: DirectorFailure;
  /** Varovné nálezy kritika nad vráceným specem. */
  readonly warnings: readonly CriticIssue[];
  readonly ms: number;
  /** Kolikrát se volal model. */
  readonly calls: number;
  /** Modely, které spec napsaly, v pořadí (`a + b`, když opravu psal jiný); přežije cache (P29B T8, R2). */
  readonly authoredBy?: string;
};

export interface DirectorDeps {
  readonly branch: GenerationBranch;
  readonly cache?: DirectorCache;
  readonly now: () => number;
  readonly seed?: number;
  /** Návrh ze slov, synchronně před prvním `await` – obálka ho může hned kompilovat. */
  readonly onDraft?: (spec: GameSpecV1) => void;
  readonly maxRepairRounds?: number;
  /**
   * Ověření hry robotem nad specem, který kritik pustil (P26 T10a): neprošlý
   * keypoint jde modelu jako nález do opravného kola. Jestli je chybná hra, nebo
   * tvrzení keypointu, rozhoduje model – tichá výměna by publikovala hru, která
   * nedělá, co tvrdí. Prázdné pole = hra prošla.
   */
  readonly check?: (spec: GameSpecV1) => readonly RepairIssue[];
  /** Kompaktní první odpověď (P27D T2, `compact.ts`); opravná kola zůstávají stejná. */
  readonly compact?: boolean;
  /** Ověřené příklady v kompaktní první odpovědi (P30A T8, `retrieval.ts`); celý GameSpec je nebere. */
  readonly examples?: boolean;
}

function warningsOf(spec: GameSpecV1): CriticIssue[] {
  return critique(spec).filter((issue) => issue.severity === 'warn');
}

export async function direct(sentence: string, deps: DirectorDeps): Promise<DirectedGame> {
  const started = deps.now();
  // P29B T5: zapnutá čtečka čte před draftem; vypnutá neodloží `onDraft` ani o jeden `await`.
  const reading = readerEnabled() ? await readBeforeDraft(sentence) : null;
  const draft = draftGameSpecWithMeta(sentence, deps.seed, { reading }).spec;
  deps.onDraft?.(draft);
  let calls = 0;

  const fallback = (reason: FallbackReason, failure: DirectorFailure): DirectedGame => ({
    ok: true,
    spec: draft,
    source: 'draft',
    repairRounds: 0,
    fallbackReason: reason,
    failure,
    warnings: warningsOf(draft),
    ms: deps.now() - started,
    calls,
  });

  const compact = deps.compact === true;
  const examples = compact && deps.examples === true;
  const request = compact ? buildCompactRequest(sentence, draft, examples) : buildDirectorRequest(sentence, draft);
  // Hra psaná s příklady má vlastní klíč cache: měření s nimi a bez nich si hry nepůjčí.
  const promptVersion = compact ? (examples ? `${COMPACT_PROMPT_VERSION}+examples:${EXAMPLES_VERSION}` : COMPACT_PROMPT_VERSION) : DIRECTOR_PROMPT_VERSION;
  const key = directorKey({ sentence, promptVersion, model: request.model, endpoint: deps.branch.id });
  const cached = deps.cache === undefined ? null : await deps.cache.read(key);
  // Záznam přijal kritik tehdejšího buildu; co dnešní kritik blokuje, je miss.
  if (cached !== null && blockingIssues(critique(cached.spec)).length === 0) {
    return {
      ok: true,
      spec: cached.spec,
      source: 'cached',
      repairRounds: 0,
      fallbackReason: null,
      warnings: warningsOf(cached.spec),
      ms: deps.now() - started,
      calls,
      ...(cached.authoredBy === null ? {} : { authoredBy: cached.authoredBy }),
    };
  }

  // Kdo psal (P29B R2): primár, nebo lokální záloha – u každého volání, které spec pohnulo.
  const authors: string[] = [];
  // Psala-li lokální záloha, hra do cache nejde: klíč patří primáru a ten by se na větu už nikdy neptal.
  let byFallback = false;
  const credit = (provenance: Readonly<Record<string, string | boolean>>) => {
    const model = provenance.model;
    if (typeof model === 'string' && !authors.includes(model)) authors.push(model);
    // Záloha se pozná podle role, kterou jí dá šev režiséra (`_director.ts`), ne podle
    // transportu: od P30A může primár i záloha jet přes týž hostovaný `openai:`.
    if (provenance.fallback === true) byFallback = true;
  };

  calls += 1;
  const outcome = await deps.branch.generate({ prompt: sentence, request });
  if (outcome.ok) credit(outcome.provenance);
  if (!outcome.ok)
    return fallback(outcome.reason === 'MALFORMED_RESPONSE' ? 'MALFORMED' : 'MODEL_UNAVAILABLE', { stage: 'model', reason: outcome.reason, detail: outcome.detail, raw: outcome.raw ?? null });

  let spec: GameSpecV1;
  // Pravidla, která se nedala složit (P29A T8): hra se složí bez nich a opravné kolo dostane důvod.
  let ruleBlocks: CriticIssue[] = [];
  const body = compact ? outcome.body : unwrapAnswer(outcome.body);
  const read = compact ? composeCompact(sentence, body, deps.seed) : readDirectorAnswer(body);
  const plain = !read.ok && compact && hasRules(body) ? composeCompact(sentence, { ...body, rules: [], things: [] }, deps.seed) : null;
  if (read.ok) {
    spec = read.spec;
  } else if (plain?.ok === true) {
    spec = plain.spec;
    ruleBlocks = ruleInvalidIssues(read.detail, (body as { rules: unknown }).rules);
  } else if (compact) {
    // Složený spec vzniká ze šablony – co neprojde, oprava tabulkou nespraví.
    return fallback('MALFORMED', { stage: 'read', reason: read.reason, detail: read.detail, raw: outcome.body });
  } else {
    const repaired = repairDeterministically(body, read.reason);
    if (repaired === null) return fallback('MALFORMED', { stage: 'read', reason: read.reason, detail: read.detail, raw: outcome.body });
    spec = repaired.spec;
  }

  // Slovesa, která první odpověď slíbila pravidly (i nesloženými).
  const promised = hasRules(body) ? [...new Set(body.rules.map((rule) => (typeof rule === 'object' && rule !== null ? (rule as { verb?: unknown }).verb : undefined)).filter((verb): verb is string => typeof verb === 'string'))] : [];
  let blocks = blockingIssues(critique(spec));
  if (blocks.length > 0) {
    const repaired = repairDeterministically(spec, blocks);
    if (repaired !== null) {
      spec = repaired.spec;
      blocks = blockingIssues(critique(spec));
    }
  }
  blocks = [...blocks, ...ruleBlocks];

  // Ověření robotem (P26 T10a) jen nad specem, který kritik pustil; neprokázané sloveso jmenuje kritik (T8).
  const checkOf = (candidate: GameSpecV1): readonly RepairIssue[] => (deps.check === undefined ? [] : verbIssues(deps.check(candidate), candidate));
  let checked = blocks.length === 0 ? checkOf(spec) : [];
  const maxRounds = deps.maxRepairRounds ?? MAX_REPAIR_ROUNDS;
  let repairRounds = 0;
  while ((blocks.length > 0 || checked.length > 0) && repairRounds < maxRounds) {
    repairRounds += 1;
    calls += 1;
    const answer = await deps.branch.generate({ prompt: sentence, request: buildRepairRequest(spec, blocks.length > 0 ? blocks : checked) });
    if (!answer.ok) {
      // Spec, který kritik pustil, jde dál a odmítne ho až publikace (NOT_PLAYABLE) –
      // výpadek opravného kola o větě nic neříká. Totéž hra, které chybí jen nesložená pravidla (T8).
      if (blocks.every((issue) => issue.code === 'RULE_INVALID')) break;
      return fallback('MODEL_UNAVAILABLE', { stage: 'model', reason: answer.reason, detail: `repair round ${repairRounds}: ${answer.detail}`, raw: answer.raw ?? null });
    }
    const applied = applyRepairAnswer(spec, answer.body);
    // Špatná záplata nechává spec i nálezy, jak byly – další kolo je dostane znovu.
    if (!applied.ok) continue;
    credit(answer.provenance);
    spec = applied.spec;
    blocks = blockingIssues(critique(spec));
    checked = blocks.length === 0 ? checkOf(spec) : [];
  }

  // Oprava pravidlům nepomohla (T8): pravidlo ze hry vypadne a hraje se bez něj –
  // nejdřív jen neprokázaná slovesa, pak všechna pravidla, nakonec návrh ze slov.
  // Neprokázané sloveso se nikdy nepublikuje a hra se kvůli pravidlu nerozbije.
  const ruleFailure = [...blocks, ...checked].filter((issue) => issue.code === 'RULE_INVALID' || issue.code === 'VERB_UNPROVED');
  const ruleFailed = blocks.every((issue) => issue.code === 'RULE_INVALID') && (ruleBlocks.length > 0 || (spec.rules !== undefined && checked.length > 0));
  if (ruleFailed && (blocks.length > 0 || checked.length > 0)) {
    const failure: DirectorFailure = { stage: 'critic', reason: 'VERB_UNPROVED', detail: ruleFailure.map((issue) => `${issue.code} ${issue.path}: ${issue.evidence}`).join('; ') || checked.map((issue) => issue.code).join('; '), raw: spec };
    const unproved = new Set(unprovedVerbs(checked));
    const candidates = [withoutRules(spec, (rule) => unproved.has(rule.verb)), withoutRules(spec, () => true)];
    for (const candidate of candidates) {
      if (candidate === null || blockingIssues(critique(candidate)).length > 0 || checkOf(candidate).length > 0) continue;
      return { ok: true, spec: candidate, source: 'authored', repairRounds, fallbackReason: 'VERB_UNPROVED', failure, warnings: warningsOf(candidate), ms: deps.now() - started, calls };
    }
    return fallback('VERB_UNPROVED', failure);
  }
  if (blocks.length > 0) return fallback('UNREPAIRED', { stage: 'critic', reason: 'UNREPAIRED', detail: blocks.map((issue) => `${issue.code} ${issue.path}: ${issue.evidence}`).join('; '), raw: spec });

  // Sloveso, které první odpověď slíbila pravidlem a hotová hra ho nenese (oprava ho
  // smazala nebo pravidla vůbec nedoplnila), se nesmí tvářit jako plně autorská hra ani jít do cache.
  const lost = promised.filter((verb) => !(spec.rules ?? []).some((rule) => rule.verb === verb));
  if (lost.length > 0) {
    const failure: DirectorFailure = { stage: 'critic', reason: 'VERB_UNPROVED', detail: `rule verbs dropped: ${lost.join(', ')}`, raw: spec };
    return { ok: true, spec, source: 'authored', repairRounds, fallbackReason: 'VERB_UNPROVED', failure, warnings: warningsOf(spec), ms: deps.now() - started, calls };
  }
  // Hra, která neprošla ověřením, se do cache nedává – příští pokus dostane novou šanci.
  const authoredBy = authors.length === 0 ? null : authors.join(' + ');
  if (checked.length === 0 && !byFallback) await deps.cache?.write(key, spec, authoredBy);
  return {
    ok: true,
    spec,
    source: 'authored',
    repairRounds,
    fallbackReason: null,
    warnings: warningsOf(spec),
    ms: deps.now() - started,
    calls,
    ...(authoredBy === null ? {} : { authoredBy }),
  };
}

const hasRules = (body: unknown): body is { rules: unknown[] } => typeof body === 'object' && body !== null && Array.isArray((body as { rules?: unknown }).rules) && (body as { rules: unknown[] }).rules.length > 0;

/** Spec bez pravidel, která `drop` vybere; `things` jen když žádné pravidlo nezbylo. `null` = nebylo co odebrat. */
function withoutRules(spec: GameSpecV1, drop: (rule: NonNullable<GameSpecV1['rules']>[number]) => boolean): GameSpecV1 | null {
  const rules = spec.rules ?? [];
  const kept = rules.filter((rule) => !drop(rule));
  if (kept.length === rules.length && rules.length > 0) return null;
  const { rules: _rules, things, ...rest } = spec;
  if (kept.length > 0) return { ...rest, rules: kept, ...(things === undefined ? {} : { things }) };
  return rest;
}

export { directorCache, directorCacheFromEnv, directorKey, type DirectorCache } from './cache';
export { type CriticIssue, blockingIssues, critique } from './critic';
export { DIRECTOR_PROMPT_VERSION, buildDirectorRequest } from './prompt';
export { readDirectorAnswer, type DirectorRead, type DirectorReadReason } from './read';
export type { RepairIssue } from './repair';
