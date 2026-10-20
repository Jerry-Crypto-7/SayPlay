/**
 * Režisér (P23-B T7): věta → `GameSpecV1`, hráč hraje hned.
 *
 * Pořadí je smysl celé vrstvy: **návrh ze slov jde ven synchronně** přes
 * `onDraft` ještě před prvním `await`, teprve pak cache, model, kritik a
 * opravy. Model píše jen `GenreSpec` (P32B T4), odpověď čte `readGenreAnswer`
 * a hru z ní složí modul žánru; blokující
 * nálezy kritika se nejdřív opravují z tabulky (`repairDeterministically`),
 * teprve pak nejvýš `maxRepairRounds` modelových kol RFC 6902. Přijatý spec se
 * uloží do cache; **cokoli jiného skončí návrhem** s `fallbackReason`, nikdy
 * výjimkou – návrh existuje vždy, takže větev `ok:false` kontraktu tady nemá
 * kdy nastat (zapsáno v `docs/play/CONTRACT-CHANGES.md`).
 *
 * `MALFORMED` = odpověď se nedala přečíst (model odpověděl něčím jiným než
 * `GenreSpec`, nebo ho modul nepřeložil); modelová kola nad ní nemají z čeho
 * záplatovat. `MODEL_UNAVAILABLE` = větev nevrátila odpověď, v prvním volání
 * nebo v opravném kole. `UNREPAIRED` režisér od P32B T5 nevrací: odpověď mimo
 * větu přepne žánr (`switchGenre`) a co neprojde ničím, dohraje žánr draftu.
 */

import type { GenerationBranch } from '@/server/pipeline';

import { arcadeWorldOf, preloadPhysics } from '../arcade/compile';
import { sentenceSky } from '../arcade/look';
import { bossKindOf, segmentNewsOf } from '../arcade/pieces/pacing';
import { abilityHint, abilityWordsOf } from '../draft/controls';
import { loadRapier } from '../arcade/physics/world';
import { LOGIC_LIMITS } from '../arcade/contract';
import { phaseEntryOf, readsLogic, rulesTouching } from '../arcade/rules/schema';
import { verifyArcade } from '../arcade/verify';
import { matchesWitness } from '../arcade/witness';
import { assemblyOfCell, liveCells } from '../compose/allowed';
import { assemblyFactory, compileRecipe } from '../compose/compile';
import { compose } from '../compose/compose';
import { recipeKey } from '../compose/recipe';
import { presetOf } from '../compose/presets';
import { essentialTriples, type Intent, type IntentTriple } from '../intent/contract';
import { extractIntent } from '../intent/extract';
import type { Reading } from '../read/schema';

import type { DirectorResult, FallbackReason } from '../contracts';
import { draftGameSpecWithMeta } from '../draft';
import type { GenreModules } from '../genre/classify';
import { readBeforeDraft, readerEnabled } from '../read/client';
import { type GameSpecV1, readGameSpec } from '../spec';
import { vocabVersion } from '../vocab';

import type { DirectorCache } from './cache';
import { directorKey } from './cache';
import { COMPACT_PROMPT_VERSION, buildCompactRequest } from './compact';
import { type CriticIssue, blockingIssues, critique, fidelity, actionIssues, ruleInvalidIssues, unprovedVerbs, verbIssues } from './critic';
import { DIRECTOR_PROMPT_VERSION, buildDirectorRequest } from './prompt';
import { answerRules, readGenreAnswer, readRecipeAnswer, readRecipeContent, readLegacyRecipeContent, readModelSpec, withoutAnswerRules } from './read';
import { EXAMPLES_VERSION } from './retrieval';
import { MAX_REPAIR_ROUNDS, type RepairIssue, applyRepairAnswer, buildRepairRequest, repairDeterministically, repairSentenceContent, switchGenre } from './repair';

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
  /** Computed from this final version, never accepted from a model declaration. */
  readonly unmet?: readonly IntentTriple[];
  /**
   * Odkud jsou pravidla hry, když ta z odpovědi robot neověřil (P46E T2): `draft` = pravidla, věci a logika
   * návrhu ze slov, `none` = ani ta neprošla a hra je bez pravidel. Chybí = pravidla odpovědi (nebo žádná nebyla).
   */
  readonly rulesFrom?: 'draft' | 'none';
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
  /** Ověřené příklady v kompaktní první odpovědi (P30A T8, `retrieval.ts`); plný prompt je nebere. */
  readonly examples?: boolean;
  /** Moduly žánrů pro draft, čtení odpovědi a kontrolu věrnosti; testy sem dávají dvojníky (`genre/__tests__/doubles.ts`). */
  readonly modules?: GenreModules;
  /** Pokyn modelu za zadáním (P46E T4: upgrade, který nic nepřidal, požádá o bosse nebo akci). */
  readonly nudge?: string;
}

function warningsOf(spec: GameSpecV1): CriticIssue[] {
  return critique(spec).filter((issue) => issue.severity === 'warn');
}

function isCompositionAnswer(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const envelope = body as Record<string, unknown>;
  const value = typeof envelope.spec === 'object' && envelope.spec !== null ? envelope.spec as Record<string, unknown> : envelope;
  return 'recipe' in value || 'genre' in value;
}

function readComposedAnswer(body: unknown, intent: Intent, seed: number, reading: Reading | null): { ok: true; spec: GameSpecV1; declared: readonly IntentTriple[] } | { ok: false; reason: string; detail: string } {
  const envelope = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const raw = typeof envelope.spec === 'object' && envelope.spec !== null ? envelope.spec as Record<string, unknown> : envelope;
  try {
    if ('recipe' in raw) {
      const read = readRecipeAnswer(body);
      if (!read.ok) return read;
      const cell = liveCells().find(candidate => recipeKey(candidate.recipe) === recipeKey(read.value.recipe))!;
      if ([cell.recipe.move, cell.recipe.objective, ...cell.recipe.actions, ...cell.recipe.threats].some(verb => intent.negated.includes(verb))) return { ok: false, reason: 'MALFORMED_SPEC', detail: 'recipe contains an explicitly forbidden action' };
      const { recipe: _recipe, unmet, ...content } = read.value;
      const checked = readRecipeContent(cell, content);
      if (!checked.ok) return { ok: false, reason: 'MALFORMED_SPEC', detail: checked.issues.join('; ') };
      const words = compose(intent, seed, reading).recipe.content;
      const corrected = repairSentenceContent(checked.value, words, intent.sentence, { reading });
      const game = readModelSpec(compileRecipe({ ...assemblyOfCell(cell, corrected), ...read.value.recipe }));
      return game.ok ? { ...game, declared: unmet } : game;
    }
    const legacy = readGenreAnswer(body, undefined, intent.sentence, reading);
    if (!legacy.ok) return legacy;
    // Keep legacy content, but choose mechanics from every essential clause.
    const assembled = compose(intent, seed, reading);
    const repaired = repairSentenceContent(legacy.genre, assembled.recipe.content, intent.sentence, { reading });
    // An authored rule program may require the original live control (carry,
    // throwHeld, contact puzzle). Moving it into a labyrinth changes its legal
    // paths and can make every rule unreachable. Keep that explicit live recipe
    // when no requested movement conflicts; the full-intent/effect verifier below
    // still repairs, admits missing actions and prevents incomplete caching.
    if ((repaired.rules?.length ?? 0) > 0 || (repaired.ruleRoles?.length ?? 0) > 0) {
      const authored = presetOf(repaired);
      const live = liveCells().some(cell => recipeKey(cell.recipe) === recipeKey(authored));
      const movementFits = intent.items.every(item => !item.essential || item.axis !== 'move' || item.verb === authored.move);
      if (live && movementFits) {
        const game = readModelSpec(compileRecipe(authored));
        return game.ok ? { ...game, declared: [] } : game;
      }
    }
    const { genre: _genre, mode: _mode, params, ...content } = repaired;
    const merged = { ...assembled.recipe.content, ...content, ...(_genre === assembled.recipe.content.genre && _mode === assembled.recipe.content.mode ? { params } : {}) };
    if (assembled.recipe.preset === 'assembled') {
      // P42 složení není živá buňka: pohyb a díly už vybral skladatel, odpověď dodá jen obsah.
      const read = readLegacyRecipeContent({ recipe: assembled.recipe, assembly: assemblyFactory(assembled.recipe), preset: assembled.recipe.content }, merged);
      if (!read.ok) return { ok: false, reason: 'MALFORMED_SPEC', detail: read.issues.join('; ') };
      const game = readModelSpec(compileRecipe({ ...assembled.recipe, content: read.value }));
      return game.ok ? { ...game, declared: [] } : game;
    }
    const cell = liveCells().find(candidate => candidate.id === assembled.cellId)!;
    const checked = readLegacyRecipeContent({ ...cell, preset: assembled.recipe.content }, merged);
    if (!checked.ok) return { ok: false, reason: 'MALFORMED_SPEC', detail: checked.issues.join('; ') };
    // A legacy cast can add an existing addon (e.g. shooting to jumping).
    // Resolve that actual assembly to a live cell; never bypass assertPreset.
    const candidate = cell.assembly !== undefined ? { ...assembled.recipe, content: checked.value } : presetOf(checked.value);
    const selectedCell = liveCells().find(live => recipeKey(live.recipe) === recipeKey(candidate));
    if (selectedCell === undefined) return { ok: false, reason: 'MALFORMED_SPEC', detail: `content requires a non-live recipe: ${recipeKey(candidate)}` };
    const game = readModelSpec(compileRecipe(assemblyOfCell(selectedCell, checked.value)));
    return game.ok ? { ...game, declared: [] } : game;
  } catch (error) {
    return { ok: false, reason: 'MALFORMED_SPEC', detail: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyDirectorSpec(spec: GameSpecV1, intent: Intent, seed: number) {
  await preloadPhysics(spec, loadRapier);
  const made = arcadeWorldOf(spec, seed);
  const triples = essentialTriples(intent);
  if (!made.ok) return { complete: false, unmet: triples, actions: actionIssues(spec, intent, seed, []), issues: [{ code: 'NOT_PLAYABLE', path: '/', evidence: made.issues.join('; '), repairHint: 'Choose a playable live recipe.' }], verbs: [] as string[], boss: false, segmented: false };
  const verdict = verifyArcade(made.world, undefined, made.roleBindings);
  const unmet = triples.filter(triple => !verdict.witnesses.some(witness => matchesWitness(triple, witness)));
  const issues = verdict.publishEligible ? [] : verbIssues(verdict.failures.map(failure => ({ code: 'NOT_PLAYABLE', path: '/', evidence: failure, repairHint: 'The actual bot must win, idle must not win, and replay must match.' })), spec);
  // Novinky režiséra (P46E T4): co robot udělal, jestli hra má bosse finále a scénář úseků. Akce nese pravidlo se
  // slovesem akce (`abilities/index.ts`), takže ji dokazuje `verbs` jako matice P46A; svědci záměru ji nenesou.
  const verbs = verdict.verbs.filter(proof => proof.changed).map(proof => proof.verb);
  return { complete: verdict.publishEligible && unmet.length === 0, unmet, actions: actionIssues(spec, intent, seed, verdict.witnesses), issues, verbs, boss: bossKindOf(made.world) !== null, segmented: segmentNewsOf(made.world).length > 0 };
}

/**
 * Akce od režiséra, které robot neudělal (P46E T4), tlačítko nedostanou: spec bez nich a nápověda ovládání
 * bez jejich kláves. Akce rychlé verze zůstanou – ty ověřilo skládání.
 */
function withoutAbilities(spec: GameSpecV1, idle: readonly string[]): GameSpecV1 {
  const { abilities = [], abilityWords, ...rest } = spec;
  const kept = abilities.filter(ability => !idle.includes(ability));
  // Slova tlačítek (P47B T10) jdou s akcemi: zahozená akce bere své slovo s sebou.
  const keptWords = abilityWordsOf(kept, Object.fromEntries((abilityWords ?? []).map((word, slot) => [abilities[slot]!, word])));
  const said = [` ${abilityHint(abilities, abilityWords)}`, ` ${abilityHint(abilities)}`].find(line => spec.tutorial.controlsHint.endsWith(line));
  const own = said === undefined ? spec.tutorial.controlsHint : spec.tutorial.controlsHint.slice(0, -said.length);
  return { ...rest, ...(kept.length === 0 ? {} : { abilities: kept }), ...(keptWords === undefined ? {} : { abilityWords: keptWords }), tutorial: { ...spec.tutorial, controlsHint: kept.length === 0 ? own : `${own} ${abilityHint(kept, keptWords)}` } };
}

/** Boss a scénář úseků od režiséra, které hra nepostavila (aréna s pravidly průběh nemá), ze specu pryč. */
function withBuiltExtras(spec: GameSpecV1, played: { readonly boss: boolean; readonly segmented: boolean }): GameSpecV1 {
  const { boss, segments, ...rest } = spec;
  return { ...rest, ...(boss === undefined || !played.boss ? {} : { boss }), ...(segments === undefined || !played.segmented ? {} : { segments }) };
}

/**
 * Počasí a denní doba z věty (P54B T11) i pro AI verzi: režisér `theme` píše sám a déšť nebo noc z věty
 * by po výměně návrhu za AI verzi zmizely. Pole, které odpověď má, zůstane; do hashe světlo nepatří.
 */
export async function direct(sentence: string, deps: DirectorDeps): Promise<DirectedGame> {
  const game = await directSpec(sentence, deps);
  const sky = sentenceSky(sentence, game.spec.theme);
  return Object.keys(sky).length === 0 ? game : { ...game, spec: { ...game.spec, theme: { ...game.spec.theme, ...sky } } };
}

async function directSpec(sentence: string, deps: DirectorDeps): Promise<DirectedGame> {
  const started = deps.now();
  const intent = extractIntent(sentence);
  if (intent.items.some(item => item.essential && item.axis === 'move' && item.verb === 'ball')) await loadRapier();
  // P29B T5: zapnutá čtečka čte před draftem; vypnutá neodloží `onDraft` ani o jeden `await`.
  const reading = readerEnabled() ? await readBeforeDraft(sentence) : null;
  const genreOptions = { reading, ...(deps.modules === undefined ? {} : { modules: deps.modules }) };
  const drafted = draftGameSpecWithMeta(sentence, deps.seed, genreOptions);
  const draft = drafted.spec;
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
    ...(drafted.composition === undefined ? {} : { unmet: drafted.composition.unmet }),
  });

  const compact = deps.compact === true;
  const examples = compact && deps.examples === true;
  const startingRequest = compact ? buildCompactRequest(sentence, drafted.genre, examples) : buildDirectorRequest(sentence, drafted.genre);
  // Slovesa, která tabulka P44C přiblížila („stabs“ → fight), režisér vidí jmenovitě – stejně jako je návrh přizná.
  const approximations = intent.items.filter((item) => item.mapped === true).map((item) => ({ said: item.said, as: item.verb }));
  const fullIntent = { sentence, essential: essentialTriples(intent), negated: intent.negated, ...(approximations.length > 0 ? { approximations } : {}) };
  const intended = deps.modules === undefined ? { ...startingRequest, user: `${startingRequest.user}\n\nFULL INTENT:\n${JSON.stringify(fullIntent)}` } : startingRequest;
  // Pokyn navíc (P46E T4, druhý pokus upgradu bez novinky) jde za zadání a má vlastní klíč cache.
  const request = deps.nudge === undefined ? intended : { ...intended, user: `${intended.user}\n\n${deps.nudge}` };
  // Hra psaná s příklady má vlastní klíč cache: měření s nimi a bez nich si hry nepůjčí. Totéž jiná tabulka sloves.
  const vocab = vocabVersion();
  const promptVersion = `${compact ? (examples ? `${COMPACT_PROMPT_VERSION}+examples:${EXAMPLES_VERSION}` : COMPACT_PROMPT_VERSION) : DIRECTOR_PROMPT_VERSION}${vocab === null ? '' : `+vocab:${vocab}`}${deps.nudge === undefined ? '' : '+nudge'}`;
  const key = directorKey({ sentence, promptVersion, model: request.model, endpoint: deps.branch.id });
  const cached = deps.cache === undefined ? null : await deps.cache.read(key);
  // Záznam přijal kritik tehdejšího buildu; co dnešní kritik blokuje, je miss.
  if (cached !== null && blockingIssues(critique(cached.spec)).length === 0 && (deps.modules !== undefined || (await verifyDirectorSpec(cached.spec, intent, deps.seed ?? 1)).complete)) {
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

  if (deps.modules === undefined) {
    const written = answerRules(outcome.body);
    const promised = new Set((written ?? []).flatMap(rule => typeof rule === 'object' && rule !== null && typeof (rule as { verb?: unknown }).verb === 'string' ? [(rule as { verb: string }).verb] : []));
    let ruleBlocks: CriticIssue[] = [];
    let selected = readComposedAnswer(outcome.body, intent, deps.seed ?? 1, reading);
    if (!selected.ok && written !== null) {
      const plain = readComposedAnswer(withoutAnswerRules(outcome.body), intent, deps.seed ?? 1, reading);
      if (plain.ok) { ruleBlocks = ruleInvalidIssues(selected.detail, written); selected = plain; }
    }
    if (!selected.ok) return fallback('MALFORMED', { stage: 'read', reason: selected.reason, detail: selected.detail, raw: outcome.body });
    const originalRuleIssues = [...ruleBlocks];
    let nativeSpec = selected.spec;
    const deterministic = repairDeterministically(nativeSpec, blockingIssues(critique(nativeSpec)));
    if (deterministic !== null) nativeSpec = deterministic.spec;
    let declared = selected.declared;
    let rounds = 0;
    let verified = await verifyDirectorSpec(nativeSpec, intent, deps.seed ?? 1);
    const issuesOf = (): RepairIssue[] => [
      ...blockingIssues(critique(nativeSpec)),
      ...ruleBlocks,
      ...(deps.check === undefined ? [] : verbIssues(deps.check(nativeSpec), nativeSpec)),
      ...verified.issues,
      ...verified.unmet.flatMap((triple, index) => declared.some(item => item.actor === triple.actor && item.verb === triple.verb && item.object === triple.object) ? [] : [verified.actions[index]!]),
    ];
    let issues = issuesOf();
    while (issues.length > 0 && rounds < (deps.maxRepairRounds ?? MAX_REPAIR_ROUNDS)) {
      rounds++; calls++;
      const repaired = await deps.branch.generate({ prompt: sentence, request: buildRepairRequest(nativeSpec, issues, intent) });
      if (!repaired.ok) {
        if (blockingIssues(critique(nativeSpec)).some(issue => issue.code !== 'RULE_INVALID')) return { ...fallback('MODEL_UNAVAILABLE', { stage: 'model', reason: repaired.reason, detail: `repair round ${rounds}: ${repaired.detail}`, raw: repaired.raw ?? null }), repairRounds: rounds };
        break;
      }
      if (isCompositionAnswer(repaired.body)) {
        selected = readComposedAnswer(repaired.body, intent, deps.seed ?? 1, reading);
        if (!selected.ok) continue;
        nativeSpec = selected.spec; declared = selected.declared; ruleBlocks = [];
      } else {
        const patched = applyRepairAnswer(nativeSpec, repaired.body);
        if (!patched.ok) continue;
        nativeSpec = patched.spec; ruleBlocks = [];
      }
      credit(repaired.provenance);
      verified = await verifyDirectorSpec(nativeSpec, intent, deps.seed ?? 1);
      issues = issuesOf();
    }
    // Broken custom rules may be removed, but every resulting candidate is
    // played again and its missing intent triples remain explicit.
    const ruleFailures = issues.filter(issue => issue.code === 'RULE_INVALID' || issue.code === 'VERB_UNPROVED');
    // Vlny a fáze z pravidel umí hru přitížit tak, že ji robot neprojde (demo 12. 10.: 6 z 25 nahraných
    // odpovědí, bez pravidel 5 z nich vyhraje) – hra bez pravidel je pořád AI verze s obsazením z odpovědi.
    // Scénář úseků a akce od režiséra (P46E T4) mění, kdy nepřátelé přijdou a co hrdina umí: hru, kterou robot
    // neprojde, zkusí nejdřív bez scénáře, pak i bez akcí (běžec se střelbou od režiséra prohrál na 465 m).
    const quickAbilities: readonly string[] = draft.abilities ?? [];
    const ownAbilities = (nativeSpec.abilities ?? []).filter(ability => !quickAbilities.includes(ability));
    const { segments: script, ...unscripted } = nativeSpec;
    const plain = ownAbilities.length === 0 ? null : withoutAbilities(unscripted, ownAbilities);
    const unplayable = (verified.issues.length > 0 || blockingIssues(critique(nativeSpec)).length > 0) && ((nativeSpec.rules?.length ?? 0) > 0 || script !== undefined || plain !== null);
    let rulesFrom: DirectedGame['rulesFrom'];
    if (ruleFailures.length > 0 || unplayable) {
      const unproved = new Set(unprovedVerbs(ruleFailures));
      // Hra bez pravidel až po pravidlech rychlé verze (P46E T2): demo 12. 10. křečkovi zmizela pravidla.
      const ruleCandidates = (base: GameSpecV1): (readonly [GameSpecV1 | null, DirectedGame['rulesFrom']])[] => {
        const bare = withoutRules(base, () => true);
        return [[withoutRules(base, rule => unproved.has(rule.verb)), undefined], [bare === null ? null : withDraftRules(draft, bare), 'draft'], [bare, 'none']];
      };
      // Pravidla zkouší i nad hrou bez akcí režiséra: s008 se střelbou prohrál s pravidly odpovědi i bez nich.
      const candidates: (readonly [GameSpecV1 | null, DirectedGame['rulesFrom']])[] = [
        ...(verified.issues.length === 0 ? [] : [...(script === undefined ? [] : [[unscripted, undefined] as const]), ...(plain === null ? [] : [[plain, undefined] as const])]),
        ...ruleCandidates(nativeSpec), ...(plain === null || verified.issues.length === 0 ? [] : ruleCandidates(plain)),
      ];
      for (const [candidate, from] of candidates) {
        if (candidate === null || blockingIssues(critique(candidate)).length > 0) continue;
        const checked = deps.check === undefined ? [] : verbIssues(deps.check(candidate), candidate);
        const played = await verifyDirectorSpec(candidate, intent, deps.seed ?? 1);
        if (checked.length > 0 || played.issues.length > 0) continue;
        nativeSpec = candidate; verified = played; ruleBlocks = []; issues = issuesOf(); rulesFrom = from;
        break;
      }
    }
    // Novinky režiséra jen ty, které hra unese (P46E T4): akce, kterou robot neudělal, tlačítko nedostane a je
    // VERB_UNPROVED; boss a úseky, které hra nepostavila, ze specu pryč. Boss je boss žánru – projde jím každá výhra.
    const idle = (nativeSpec.abilities ?? []).filter(ability => !quickAbilities.includes(ability) && !verified.verbs.includes(ability));
    // Akce, se kterými robot nevyhrál (kandidát bez nich), jsou neprokázané stejně jako ty, které nepoužil.
    const kept: readonly string[] = nativeSpec.abilities ?? [];
    const lost = ownAbilities.filter(ability => !kept.includes(ability));
    const unbuilt = (nativeSpec.boss !== undefined && !verified.boss) || (nativeSpec.segments !== undefined && !verified.segmented);
    if (verified.issues.length === 0 && (idle.length > 0 || lost.length > 0 || unbuilt)) {
      const candidate = withBuiltExtras(idle.length === 0 ? nativeSpec : withoutAbilities(nativeSpec, idle), verified);
      const played = idle.length === 0 ? verified : await verifyDirectorSpec(candidate, intent, deps.seed ?? 1);
      if (played.issues.length === 0 && blockingIssues(critique(candidate)).length === 0) { nativeSpec = candidate; verified = played; }
      const unproved = (ability: string, evidence: string): CriticIssue => ({ code: 'VERB_UNPROVED', severity: 'block', path: '/abilities', evidence, repairHint: `give the hero a reason to ${ability} on the way to the win, or leave the ability out` });
      issues = [...issuesOf(), ...lost.map(ability => unproved(ability, `the robot did not win with the "${ability}" ability`)), ...idle.map(ability => unproved(ability, `the robot never used the "${ability}" ability`))];
    }
    // Final verification is for the exact version after every accepted repair.
    if (verified.issues.length > 0 || blockingIssues(critique(nativeSpec)).length > 0) return { ...fallback('UNREPAIRED', { stage: 'critic', reason: 'UNREPAIRED', detail: issues.map(issue => `${issue.code}: ${issue.evidence}`).join('; '), raw: nativeSpec }), repairRounds: rounds };
    const authoredBy = authors.length === 0 ? null : authors.join(' + ');
    const dropped = [...promised].filter(verb => !(nativeSpec.rules ?? []).some(rule => rule.verb === verb));
    const incomplete = issues.length > 0 || dropped.length > 0;
    if (verified.complete && !incomplete && !byFallback) await deps.cache?.write(key, nativeSpec, authoredBy);
    return { ok: true, spec: nativeSpec, source: 'authored', repairRounds: rounds, fallbackReason: incomplete ? 'VERB_UNPROVED' : null,
      ...(!incomplete ? {} : { failure: { stage: 'critic' as const, reason: issues.some(issue => issue.code === 'ACTION_LOST') ? 'ACTION_LOST' : 'VERB_UNPROVED', detail: [...issues.map(issue => `${issue.code}: ${issue.evidence}`), ...(dropped.length === 0 ? [] : [...originalRuleIssues.map(issue => `${issue.code}: ${issue.evidence}`), `rule verbs dropped: ${dropped.join(', ')}`])].join('; '), raw: nativeSpec } }),
      unmet: verified.unmet, warnings: warningsOf(nativeSpec), ms: deps.now() - started, calls, ...(authoredBy === null ? {} : { authoredBy }), ...(rulesFrom === undefined ? {} : { rulesFrom }) };
  }

  // Hru skládá modul žánru – co se nepřečte nebo nepřeloží, oprava tabulkou nespraví.
  // Pravidla, která se nedala složit (P29A T8, v první odpovědi znovu od T5b): hra se složí bez nich a opravné kolo dostane důvod.
  const written = answerRules(outcome.body);
  let ruleBlocks: CriticIssue[] = [];
  let read = readGenreAnswer(outcome.body, deps.modules, sentence, reading);
  if (!read.ok && written !== null) {
    const plain = readGenreAnswer(withoutAnswerRules(outcome.body), deps.modules, sentence, reading);
    if (plain.ok) ruleBlocks = ruleInvalidIssues(read.detail, written);
    if (plain.ok) read = plain;
  }
  if (!read.ok) return fallback('MALFORMED', { stage: 'read', reason: read.reason, detail: read.detail, raw: outcome.body });
  let spec: GameSpecV1 = read.spec;
  // Slovesa, která první odpověď slíbila pravidly (i nesloženými).
  const promised = [...new Set((written ?? []).map((rule) => (typeof rule === 'object' && rule !== null ? (rule as { verb?: unknown }).verb : undefined)).filter((verb): verb is string => typeof verb === 'string'))];

  /**
   * Poslední záloha opravy žánrové odpovědi (T5): žánr draftu. Hláška „could
   * not fix“ (`UNREPAIRED`) pro žánrový spec neexistuje – hra je rychlá verze a
   * obálka ji ohlásí jako „the quick version is already its take“ (UNCHANGED).
   * Do cache nejde: příští pokus dostane novou šanci.
   */
  const draftGenre = (failure: DirectorFailure, repairRounds: number): DirectedGame => ({
    ok: true,
    spec: draft,
    source: 'authored',
    repairRounds,
    fallbackReason: null,
    failure,
    warnings: warningsOf(draft),
    ms: deps.now() - started,
    calls,
  });

  // Kontrola věrnosti (T5): hrdina, obsazení proti větě (P39) a sloveso věty, režim `ready`; neprošlá odpověď přepne žánr podle klasifikátoru.
  const unfaithful = fidelity(read.genre, sentence, genreOptions);
  if (unfaithful.length > 0) {
    const switched = switchGenre(read.genre, sentence, genreOptions);
    const detail = unfaithful.map((issue) => `${issue.code} ${issue.path}: ${issue.evidence}`).join('; ');
    if (switched === null) return draftGenre({ stage: 'critic', reason: 'UNFAITHFUL', detail, raw: read.genre }, 0);
    spec = switched.spec;
  }

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
    const bare = withoutRules(spec, () => true);
    const candidates = [[withoutRules(spec, (rule) => unproved.has(rule.verb)), undefined], [bare === null ? null : withDraftRules(draft, bare), 'draft'], [bare, 'none']] as const;
    for (const [candidate, from] of candidates) {
      if (candidate === null || blockingIssues(critique(candidate)).length > 0 || checkOf(candidate).length > 0) continue;
      return { ok: true, spec: candidate, source: 'authored', repairRounds, fallbackReason: 'VERB_UNPROVED', failure, warnings: warningsOf(candidate), ms: deps.now() - started, calls, ...(from === undefined ? {} : { rulesFrom: from }) };
    }
    return fallback('VERB_UNPROVED', failure);
  }
  if (blocks.length > 0) return draftGenre({ stage: 'critic', reason: 'UNREPAIRED', detail: blocks.map((issue) => `${issue.code} ${issue.path}: ${issue.evidence}`).join('; '), raw: spec }, repairRounds);

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

/**
 * Spec bez pravidel, která `drop` vybere; `null` = nebylo co odebrat, nebo výsledek `readGameSpec` odmítne
 * (R6-2: např. vyhlášená událost bez posluchače). Kandidát z vyřazení jde do publikace bez dalšího čtení.
 */
function withoutRules(spec: GameSpecV1, drop: (rule: NonNullable<GameSpecV1['rules']>[number]) => boolean): GameSpecV1 | null {
  const candidate = droppedRules(spec, drop);
  return candidate !== null && readGameSpec(candidate).ok ? candidate : null;
}

/**
 * Hra `spec` s pravidly, věcmi a logikou návrhu (P46E T2, vzor `onQuickGame` v `_upgrade.ts`). Bez vlastní logiky si
 * `spec` nechá svá pravidla a věci za těmi z návrhu; s vlastní logikou je návrh nahradí, protože dva průběhy fází
 * vedle sebe neběží. `null` = návrh pravidla nemá, nebo výsledek `readGameSpec` odmítne (např. role, kterou pravidlo
 * návrhu volá, ve hře `spec` není).
 */
export function withDraftRules(draft: GameSpecV1, spec: GameSpecV1): GameSpecV1 | null {
  const rules = draft.rules ?? [];
  if (rules.length === 0) return null;
  const { rules: own = [], things: ownThings = [], logic, ...rest } = spec;
  const merge = logic === undefined;
  const things = [...(draft.things ?? []), ...(merge ? ownThings.filter((thing) => !(draft.things ?? []).some((each) => each.role === thing.role)) : [])];
  const read = readGameSpec({
    ...rest,
    rules: [...rules, ...(merge ? own.filter((rule) => !rules.some((each) => each.id === rule.id)) : [])],
    ...(things.length === 0 ? {} : { things }),
    ...(draft.logic === undefined ? {} : { logic: draft.logic }),
  });
  return read.ok ? read.value : null;
}

/** Spec bez pravidel, která `drop` vybere; `things` jen když žádné pravidlo nezbylo. `null` = nebylo co odebrat. */
function droppedRules(spec: GameSpecV1, drop: (rule: NonNullable<GameSpecV1['rules']>[number]) => boolean): GameSpecV1 | null {
  const rules = spec.rules ?? [];
  let kept = rules.filter((rule) => !drop(rule));
  // Vstup doplněný čtením (`phaseEntryOf`, R6) jde ven jen s fází: vypadl-li on, nebo vše, co na fázi
  // reaguje, odejde fáze z bloku `logic` i s pravidly, která na ni sahají. Fáze za ní vede z ní, proto znovu.
  const entered = rules.flatMap((rule) => phaseEntryOf(rule) ?? []);
  const declared = (spec.logic?.phases ?? []).map((phase) => phase.id);
  const gone = new Set<string>();
  for (;;) {
    const lone = entered.filter((phase) => {
      const own = rulesTouching(kept, 'phase', phase).map((index) => phaseEntryOf(kept[index]!) === phase);
      return !gone.has(phase) && (!own.includes(true) || !own.includes(false));
    });
    // Jediná zbylá fáze není průběh a schéma chce aspoň dvě (`LOGIC_LIMITS.minPhases`) – odejde i ona.
    const left = declared.filter((phase) => !gone.has(phase) && !lone.includes(phase));
    if (gone.size + lone.length > 0 && left.length < LOGIC_LIMITS.minPhases) lone.push(...left);
    if (lone.length === 0) break;
    for (const phase of lone) gone.add(phase);
    const touched = new Set(lone.flatMap((phase) => rulesTouching(kept, 'phase', phase)));
    kept = kept.filter((_, index) => !touched.has(index));
  }
  if (kept.length === rules.length && rules.length > 0) return null;
  // Blok `logic` (P45B T10) jde pryč s posledním pravidlem, které ho čte – mrtvou deklaraci `readGameSpec` odmítne.
  const { rules: _rules, things, logic, ...rest } = spec;
  const { phases: _phases, ...logicRest } = logic ?? {};
  const phases = (logic?.phases ?? []).filter((phase) => !gone.has(phase.id));
  const withLogic = logic !== undefined && kept.some(readsLogic) ? { logic: { ...logicRest, ...(phases.length === 0 ? {} : { phases }) } } : {};
  if (kept.length > 0) return { ...rest, ...withLogic, rules: kept, ...(things === undefined ? {} : { things }) };
  return rest;
}

export { directorCache, directorCacheFromEnv, directorKey, type DirectorCache } from './cache';
export { type CriticIssue, blockingIssues, critique } from './critic';
export { DIRECTOR_PROMPT_VERSION, buildDirectorRequest } from './prompt';
export { readDirectorAnswer, type DirectorRead, type DirectorReadReason } from './read';
export type { RepairIssue } from './repair';
