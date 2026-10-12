/**
 * Čtení odpovědi režiséra (P23-B T4).
 *
 * `GenerationBranch.generate(call).body` je už rozparsované JSON; co tady
 * přijde, je cokoli, co model napsal. Dvě odmítnutí jsou navíc proti
 * `readGameSpec`, protože obě potřebuje opravné kolo poznat dřív, než by
 * schéma řeklo jen „tvar nesedí":
 *
 * - `WRONG_DOCUMENT` – model opsal `WorldDoc`/blueprint, který zná z jiných
 *   promptů (`sim`, `geometry`, `world`). Oprava RFC 6902 nad tím nemá smysl;
 *   jediná cesta je nové kolo s výslovným záporným příkladem.
 * - `MECHANIC_REJECTED` s názvem mechaniky – neznámé `id` v `mechanics`
 *   spadne v `readGameSpec` na uzavřený enum, tedy `MALFORMED_SPEC`, a
 *   deterministická oprava (`projectile → defeat`) by neměla podle čeho sáhnout.
 *   Kontrola tady předbíhá schéma o jeden krok a `detail` nese ta jména.
 */

import { arcadeWorldOf } from '../arcade/compile';
import { logicSchema, rulesSchema, withPhaseEntries, withStartedTimers } from '../arcade/rules/schema';
import { liveCells } from '../compose/allowed';
import { recipeKey } from '../compose/recipe';
import { recipeAnswerSchema, nativeRecipeParams, type RecipeAnswer } from './answer-schema';

import { draftGenreFor, twistGoalFor } from '../draft/draft';
import { singular } from '../draft/lexicon';
import type { GenreModules } from '../genre/classify';
import { CAST_MAX, type GenreModule, type GenreSpec, genreSpecSchema, castFor } from '../genre/contract';
import { GENRE_MODULES, compileWith, readGenreSpec } from '../genre/index';
import { RIDE_WORDS } from '../genre/runner';
import { isAmmo } from '../genre/throw';
import type { Reading } from '../read/schema';
import { MECHANIC_IDS } from '../registry';
import { readGameSpec, type GameSpecReason, type GameSpecV1 } from '../spec';

export type DirectorReadReason = GameSpecReason | 'NOT_AN_OBJECT' | 'WRONG_DOCUMENT';

export type DirectorRead =
  | { readonly ok: true; readonly spec: GameSpecV1 }
  | { readonly ok: false; readonly reason: DirectorReadReason; readonly detail: string };

const WORLD_DOC_KEYS = ['sim', 'geometry', 'world'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Přísný režim píše chybějící volitelné pole jako `null`; spec ho chce vynechané. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([name, item]) => [name, withoutNulls(item)]));
  return value;
}

/** Spec s doplněným vstupem do fáze, na kterou pravidlo reaguje (`withPhaseEntries`); beze změny, když není co doplnit. */
function withEnteredPhases(input: unknown): unknown {
  if (!isRecord(input)) return input;
  // Logika bez jediného pravidla nic nedělá a `readGameSpec` by kvůli ní odmítl celou odpověď (demo 12. 10.: si-018).
  if (input.logic !== undefined && (!Array.isArray(input.rules) || input.rules.length === 0)) {
    const { logic: _, ...rest } = input;
    return rest;
  }
  const rules = rulesSchema.safeParse(input.rules);
  const logic = logicSchema.safeParse(input.logic);
  if (!rules.success || !logic.success) return input;
  const entered = withPhaseEntries(rules.data, logic.data);
  const timed = withStartedTimers(entered, logic.data);
  if (timed.rules === rules.data && timed.logic === logic.data) return input;
  return { ...input, rules: timed.rules, ...(timed.logic === logic.data ? {} : { logic: timed.logic }) };
}

/** Neznámá `id` v `mechanics`, v pořadí výskytu; prázdné, když je pole nečitelné. */
export function unknownMechanicIds(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.mechanics)) return [];
  const known = new Set<string>(MECHANIC_IDS);
  const unknown: string[] = [];
  for (const mechanic of body.mechanics) {
    if (isRecord(mechanic) && typeof mechanic.id === 'string' && !known.has(mechanic.id)) unknown.push(mechanic.id);
  }
  return unknown;
}

export function readDirectorAnswer(body: unknown): DirectorRead {
  if (!isRecord(body)) return { ok: false, reason: 'NOT_AN_OBJECT', detail: `answer is ${Array.isArray(body) ? 'an array' : typeof body}` };
  const foreign = WORLD_DOC_KEYS.filter((key) => key in body);
  if (foreign.length > 0) return { ok: false, reason: 'WRONG_DOCUMENT', detail: `answer looks like a WorldDoc: has ${foreign.join(', ')}` };
  const unknown = unknownMechanicIds(body);
  if (unknown.length > 0) return { ok: false, reason: 'MECHANIC_REJECTED', detail: `unknown mechanic: ${unknown.join(', ')}` };
  return readModelSpec(body);
}

export interface RecipeContentCell {
  readonly recipe: { readonly move: string };
  readonly assembly?: string;
  readonly preset: GenreSpec;
}

/** Validate native factory inputs before compilation; never validate them as a legacy genre. */
export function readRecipeContent(cell: RecipeContentCell, content: unknown): { ok: true; value: GenreSpec } | { ok: false; issues: readonly string[] } {
  if (!isRecord(content)) return { ok: false, issues: ['content must be an object'] };
  const input = { ...cell.preset, ...content };
  const native = cell.assembly === 'catch' ? 'catch' : cell.assembly === 'drive' ? 'drive' : cell.assembly === 'native' && ['glide', 'walk', 'ball'].includes(cell.recipe.move) ? cell.recipe.move as 'glide' | 'walk' | 'ball' : null;
  if (native === null) return readGenreSpec(input);
  const shape = genreSpecSchema.safeParse(input);
  if (!shape.success) return { ok: false, issues: shape.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) };
  const params = nativeRecipeParams[native].safeParse(shape.data.params ?? {});
  if (!params.success) return { ok: false, issues: params.error.issues.map(issue => `params.${issue.path.join('.')}: ${issue.message}`) };
  // Ball alone currently reads a content count (target). Other native counts
  // must not disappear into a legacy placeholder genre or a factory default.
  for (const [key, value] of Object.entries(shape.data.counts ?? {})) {
    if (native !== 'ball' || key !== 'target' || value === undefined || !nativeRecipeParams.ball.shape.targets.safeParse(value).success) return { ok: false, issues: [`counts.${key}: unsupported or out of bounds for ${native}`] };
  }
  if (native === 'ball' && shape.data.params?.targets !== undefined && shape.data.counts?.target !== undefined && shape.data.params.targets !== shape.data.counts.target) return { ok: false, issues: ['params.targets and counts.target conflict'] };
  return { ok: true, value: shape.data };
}

/** Convert only an already validated legacy answer to the selected native vocabulary.
 * Removed legacy-only numeric knobs are not claims of support; full-intent verification
 * still decides which actions were played. Explicit recipe answers use the strict reader.
 */
export function readLegacyRecipeContent(cell: RecipeContentCell, content: GenreSpec): ReturnType<typeof readRecipeContent> {
  const native = cell.assembly === 'catch' ? 'catch' : cell.assembly === 'drive' ? 'drive' : cell.assembly === 'native' && ['glide', 'walk', 'ball'].includes(cell.recipe.move) ? cell.recipe.move as 'glide' | 'walk' | 'ball' : null;
  if (native === null) return readRecipeContent(cell, content);
  const vocabulary = nativeRecipeParams[native].shape;
  const params = Object.fromEntries(Object.entries(content.params ?? {}).filter(([key]) => Object.hasOwn(vocabulary, key)));
  // Always override preset.params: the preset may itself carry old quest knobs.
  // Shared keys are validated against the native bounds by readRecipeContent.
  return readRecipeContent(cell, { ...content, params });
}

export type RecipeRead = { readonly ok: true; readonly value: RecipeAnswer } | Extract<DirectorRead, { ok: false }>;

/** Recipe answers are selections, not proof. Composition must verify full Intent. */
export function readRecipeAnswer(body: unknown): RecipeRead {
  if (!isRecord(body)) return { ok: false, reason: 'NOT_AN_OBJECT', detail: `answer is ${Array.isArray(body) ? 'an array' : typeof body}` };
  const raw = answerSpec(body);
  const cleaned = withoutNulls(raw) as Record<string, unknown>;
  // In a triple null means untargeted, not an omitted field.
  if (Array.isArray(raw.unmet)) cleaned.unmet = raw.unmet.map(triple => isRecord(triple) ? { ...triple } : triple);
  const parsed = recipeAnswerSchema.safeParse(cleaned);
  if (!parsed.success) return { ok: false, reason: 'MALFORMED_SPEC', detail: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
  if (!liveCells().some(cell => recipeKey(cell.recipe) === recipeKey(parsed.data.recipe))) return { ok: false, reason: 'MALFORMED_SPEC', detail: `recipe is not a live combination: ${recipeKey(parsed.data.recipe)}` };
  return { ok: true, value: { ...parsed.data, hero: singular(parsed.data.hero), ...(parsed.data.cast === undefined ? {} : { cast: parsed.data.cast.map(item => ({ ...item, label: singular(item.label) })) }) } };
}

export type GenreRead = { readonly ok: true; readonly spec: GameSpecV1; readonly genre: GenreSpec } | Extract<DirectorRead, { ok: false }>;

/**
 * Odpověď režiséra na novou hru (P32B T4): `{plan, spec}` se `GenreSpec`
 * (`GENRE_ANSWER_SCHEMA`) nebo holý `GenreSpec` z větve bez schématu → bez
 * polí `null` → `readGenreSpec` (tvar a meze parametrů) → popisky rolí v jednotném čísle → modul žánru
 * (`compileGenreSpec`) → `readModelSpec`. Hru tak vždy skládá modul žánru, model píše jen výběr.
 * `modules` jsou pro testy (dvojníci); meze parametrů drží vždy skutečné moduly.
 * `sentence` = věta hráče: u běžce z ní jde jízda (`ride`) stejně jako v rychlé verzi,
 * u skákačky věc a cíl, které odpověď vynechala (`reading` = čtení téže věty jako u rychlé verze).
 */
export function readGenreAnswer(body: unknown, modules: GenreModules = GENRE_MODULES, sentence?: string, reading: Reading | null = null): GenreRead {
  if (!isRecord(body)) return { ok: false, reason: 'NOT_AN_OBJECT', detail: `answer is ${Array.isArray(body) ? 'an array' : typeof body}` };
  const raw = answerSpec(body);
  const foreign = WORLD_DOC_KEYS.filter((key) => key in raw);
  if (foreign.length > 0) return { ok: false, reason: 'WRONG_DOCUMENT', detail: `answer looks like a WorldDoc: has ${foreign.join(', ')}` };
  const read = readGenreSpec(withoutNulls(raw));
  if (!read.ok) return { ok: false, reason: 'MALFORMED_SPEC', detail: read.issues.join('; ') };
  const genre = sentence === undefined ? singularRoles(read.value) : ammoOfSentence(goalOfSentence(rideOfSentence(singularRoles(read.value), sentence), sentence, reading, modules), sentence, reading, modules);
  const game = compileGenreSpec(genre, modules);
  if (!game.ok) return game;
  // Věta mimo hry (P37A T5): AI verze řekne cíl slovy věty jako návrh („Dodge the long queues!“).
  const goal = sentence === undefined ? null : twistGoalFor(sentence, genre, reading, modules);
  return { ok: true, spec: goal === null ? game.spec : { ...game.spec, tutorial: { ...game.spec.tutorial, goalLine: goal } }, genre };
}

/**
 * Věc a cíl skákačky podle věty (P35 T9): model je u skákačky vynechává a AI
 * verze sbírací věty pak ukázala „Reach the flag“, i když rychlá verze téže
 * věty sbírala mrkve. Co odpověď nenapsala – věc (`collect`), cíl (`reach`),
 * počet věcí – doplní rychlá verze (`draftGenreFor`); co napsala, platí.
 * Sbírací sloveso, které v rychlé verzi nese sama věc („grab 3 apples“, P39 T7),
 * přejde na věc odpovědi; cíl, který v rychlé verzi jen opakuje věc, dostane
 * věc odpovědi – ani jedno z věci odpovědi neudělá cíl úrovně.
 */
function goalOfSentence(genre: GenreSpec, sentence: string, reading: Reading | null, modules: GenreModules): GenreSpec {
  const item = castFor(genre, 'collect');
  const goal = castFor(genre, 'reach');
  if (genre.genre !== 'platformer' || (item !== undefined && goal !== undefined)) return genre;
  const words = draftGenreFor(sentence, genre.genre, genre.mode, { reading, modules });
  if (words === null) return genre;
  const wordItem = castFor(words, 'collect');
  const wordGoal = castFor(words, 'reach');
  const carried = item !== undefined && item.verb === undefined && goal === undefined && wordGoal === undefined && wordItem?.verb !== undefined ? { ...item, verb: wordItem.verb } : item;
  const nextItem = carried ?? wordItem;
  const echo = wordGoal !== undefined && wordItem !== undefined && singular(wordGoal.label) === singular(wordItem.label);
  const nextGoal = goal ?? (wordGoal !== undefined && echo && nextItem !== undefined ? { ...wordGoal, label: nextItem.label } : wordGoal);
  const cast = [
    ...(genre.cast ?? []).map((written) => (written === item && nextItem !== undefined ? nextItem : written)),
    ...(item === undefined && nextItem !== undefined ? [nextItem] : []),
    ...(goal === undefined && nextGoal !== undefined ? [nextGoal] : []),
  ].slice(0, CAST_MAX);
  const counted = genre.params?.items !== undefined || genre.counts?.collectible !== undefined || words.counts?.collectible === undefined;
  return {
    ...genre,
    ...(cast.length === 0 ? {} : { cast }),
    ...(counted ? {} : { counts: { ...genre.counts, collectible: words.counts!.collectible } }),
  };
}

/**
 * Náboj hodu podle věty (P39 T14): prompt zakazuje obsadit, co hráč hází, takže
 * odpověď náboj nemá a hod by vzal první sbíranou věc („grabs acorns … throws
 * pinecones“ házel žaludy). Náboj, který odpověď nenapsala, doplní rychlá verze
 * téhož režimu; co napsala, platí – i ořez na `CAST_MAX`.
 */
export function ammoOfSentence(genre: GenreSpec, sentence: string, reading: Reading | null, modules: GenreModules): GenreSpec {
  if (genre.genre !== 'throw' || genre.cast?.some(isAmmo) === true) return genre;
  const ammo = draftGenreFor(sentence, genre.genre, genre.mode, { reading, modules })?.cast?.find(isAmmo);
  return ammo === undefined ? genre : { ...genre, cast: [...(genre.cast ?? []), ammo].slice(0, CAST_MAX) };
}

/**
 * Popisky obsazení v jednotném čísle, stejnou funkcí jako rychlá verze (P32B T7):
 * šablony modulů mluví o jednom kusu, takže „rocks“ by dalo „without hitting a rocks“.
 * Hrdina zůstane – do šablon počtů nejde a nese titulek hry („Dinosaurs Run“).
 */
function singularRoles(genre: GenreSpec): GenreSpec {
  return genre.cast === undefined ? genre : { ...genre, cast: genre.cast.map((item) => ({ ...item, label: singular(item.label) })) };
}

/**
 * Jízda běžce podle věty, ne podle modelu: rychlá verze ji čte z věty
 * (`RIDE_WORDS` v `runnerGenre.draftFill`), a AI verze téže věty tak nesmí
 * lyžaře postavit na nohy ani běžce posadit na prkno. Věta vyhrává oběma směry.
 */
function rideOfSentence(genre: GenreSpec, sentence: string): GenreSpec {
  if (genre.genre !== 'runner') return genre;
  const { ride: _written, ...params } = genre.params ?? {};
  const rides = RIDE_WORDS.test(sentence.toLowerCase());
  const next = rides ? { ...params, ride: 1 } : params;
  const { params: _params, ...rest } = genre;
  return Object.keys(next).length === 0 ? rest : { ...rest, params: next };
}

/** Spec žánrové odpovědi: `{plan, spec}`, nebo holý spec z větve bez schématu. */
function answerSpec(body: Record<string, unknown>): Record<string, unknown> {
  return typeof body.plan === 'string' && isRecord(body.spec) ? body.spec : body;
}

/** Pravidla, jak je žánrová odpověď napsala (B-R5); `null` = žádná. */
export function answerRules(body: unknown): readonly unknown[] | null {
  const rules = isRecord(body) ? answerSpec(body).rules : undefined;
  return Array.isArray(rules) && rules.length > 0 ? rules : null;
}

/**
 * Žánrová odpověď bez pravidel a doplňků – hra žánru, když se pravidla nedají
 * složit. Role pravidel zůstanou, aby je opravné kolo mohlo pravidly znovu
 * oslovit (jako P29A T8); vadné role pravidel odpověď neprojdou ani tak.
 */
export function withoutAnswerRules(body: unknown): unknown {
  if (!isRecord(body)) return body;
  // Blok `logic` (P45B T10) bez pravidel by byl mrtvá deklarace – jde pryč s nimi.
  const { rules: _rules, things: _things, logic: _logic, ...rest } = answerSpec(body);
  return answerSpec(body) === body ? rest : { ...body, spec: rest };
}

/** `GenreSpec` → hra modulem jeho žánru, přečtená jako spec od modelu; počty rolí jdou do parametrů modulu (B-R4). */
export function compileGenreSpec(genre: GenreSpec, modules: GenreModules = GENRE_MODULES): DirectorRead {
  return readModelSpec(compileWith(modules[genre.genre] as GenreModule, genre));
}

/**
 * `readGameSpec` pro spec od modelu – první odpověď i záplata opravy čtou
 * totéž (B-R6). Od B-R8 model smí všechny spouštěče; meze `interact` soudí
 * `ruleIssues` v `readGameSpec`, takže platí i pro přenos, který schéma
 * odpovědi neposílá (Messages).
 *
 * Fáze, na kterou pravidlo reaguje a nic do ní nevede, dostane vstupní pravidlo
 * (`withPhaseEntries`, P45B T11) – gpt-oss-20b fázi deklaruje, ale přepnutí do ní
 * vynechá. Platí jen, když spec s ním projde a svět ho unese: strop pravidel jádra
 * počítá i vestavěná pravidla hry (`arcade/compile.ts`). Jinak se čte, jak ho model napsal.
 */
export function readModelSpec(input: unknown): DirectorRead {
  const entered = withEnteredPhases(input);
  const repaired = entered === input ? null : readGameSpec(entered);
  const result = repaired?.ok === true && arcadeWorldOf(repaired.value, 1).ok ? repaired : readGameSpec(input);
  return result.ok ? { ok: true, spec: result.value } : { ok: false, reason: result.reason, detail: result.issues.join('; ') };
}
