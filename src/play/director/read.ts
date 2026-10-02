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

import { draftGenreFor } from '../draft/draft';
import { singular } from '../draft/lexicon';
import type { GenreModules } from '../genre/classify';
import type { GenreModule, GenreSpec } from '../genre/contract';
import { GENRE_MODULES, compileWith, readGenreSpec } from '../genre/index';
import { RIDE_WORDS } from '../genre/runner';
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
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([name, item]) => [name, withoutNulls(item)]));
  return value;
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
  const genre = sentence === undefined ? singularRoles(read.value) : goalOfSentence(rideOfSentence(singularRoles(read.value), sentence), sentence, reading, modules);
  const game = compileGenreSpec(genre, modules);
  return game.ok ? { ok: true, spec: game.spec, genre } : game;
}

/**
 * Věc a cíl skákačky podle věty (P35 T9): model je u skákačky vynechává a AI
 * verze sbírací věty pak ukázala „Reach the flag“, i když rychlá verze téže
 * věty sbírala mrkve. Co odpověď nenapsala – věc, cíl, počet věcí – doplní
 * rychlá verze (`draftGenreFor`); co napsala, platí. Cíl, který v rychlé verzi
 * jen opakuje věc („grab apples“), dostane věc odpovědi, ať se z ní nestane cíl úrovně.
 */
function goalOfSentence(genre: GenreSpec, sentence: string, reading: Reading | null, modules: GenreModules): GenreSpec {
  if (genre.genre !== 'platformer' || (genre.collectible !== undefined && genre.target !== undefined)) return genre;
  const words = draftGenreFor(sentence, genre.genre, genre.mode, { reading, modules });
  if (words === null) return genre;
  const collectible = genre.collectible ?? words.collectible;
  const echo = words.target !== undefined && words.collectible !== undefined && singular(words.target.label) === singular(words.collectible);
  const target = genre.target ?? (words.target !== undefined && echo && collectible !== undefined ? { ...words.target, label: collectible } : words.target);
  const counted = genre.params?.items !== undefined || genre.counts?.collectible !== undefined || words.counts?.collectible === undefined;
  return {
    ...genre,
    ...(collectible === undefined ? {} : { collectible }),
    ...(target === undefined ? {} : { target }),
    ...(counted ? {} : { counts: { ...genre.counts, collectible: words.counts!.collectible } }),
  };
}

/**
 * Popisky rolí v jednotném čísle, stejnou funkcí jako rychlá verze (P32B T7):
 * šablony modulů mluví o jednom kusu, takže „rocks“ by dalo „without hitting a rocks“.
 * Hrdina zůstane – do šablon počtů nejde a nese titulek hry („Dinosaurs Run“).
 */
function singularRoles(genre: GenreSpec): GenreSpec {
  return {
    ...genre,
    ...(genre.enemy === undefined ? {} : { enemy: singular(genre.enemy) }),
    ...(genre.collectible === undefined ? {} : { collectible: singular(genre.collectible) }),
    ...(genre.target === undefined ? {} : { target: { ...genre.target, label: singular(genre.target.label) } }),
  };
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
  const { rules: _rules, things: _things, ...rest } = answerSpec(body);
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
 */
export function readModelSpec(input: unknown): DirectorRead {
  const result = readGameSpec(input);
  return result.ok ? { ok: true, spec: result.value } : { ok: false, reason: result.reason, detail: result.issues.join('; ') };
}
