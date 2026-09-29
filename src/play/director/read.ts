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

import { modelWhenSchema } from '../arcade/rules/schema';
import type { GenreSpec } from '../genre/contract';
import { compileGenre, readGenreSpec } from '../genre/index';
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
 * polí `null` → `readGenreSpec` (tvar a meze parametrů) → `compileGenre` →
 * `readModelSpec`. Hru tak vždy skládá modul žánru, model píše jen výběr.
 */
export function readGenreAnswer(body: unknown): GenreRead {
  if (!isRecord(body)) return { ok: false, reason: 'NOT_AN_OBJECT', detail: `answer is ${Array.isArray(body) ? 'an array' : typeof body}` };
  const raw = typeof body.plan === 'string' && isRecord(body.spec) ? body.spec : body;
  const foreign = WORLD_DOC_KEYS.filter((key) => key in raw);
  if (foreign.length > 0) return { ok: false, reason: 'WRONG_DOCUMENT', detail: `answer looks like a WorldDoc: has ${foreign.join(', ')}` };
  const genre = readGenreSpec(withoutNulls(raw));
  if (!genre.ok) return { ok: false, reason: 'MALFORMED_SPEC', detail: genre.issues.join('; ') };
  const game = readModelSpec(compileGenre(genre.value));
  return game.ok ? { ok: true, spec: game.spec, genre: genre.value } : game;
}

/**
 * `readGameSpec` pro spec od modelu: navíc odmítne spouštěč, který schéma
 * odpovědi nenabízí (pahýl `interact`, `modelWhenSchema`). Schéma to vynutí jen
 * přenos, který ho posílá – přenos Messages ne (revize P32-0 T4-R2).
 */
export function readModelSpec(input: unknown): DirectorRead {
  const result = readGameSpec(input);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.issues.join('; ') };
  const stubs = (result.value.rules ?? []).flatMap((rule, index) =>
    modelWhenSchema.safeParse(rule.when).success ? [] : [`/rules/${index}/when: ${Object.keys(rule.when).join()} does nothing yet – use a trigger from the rules grammar`],
  );
  if (stubs.length > 0) return { ok: false, reason: 'MALFORMED_SPEC', detail: stubs.join('; ') };
  return { ok: true, spec: result.value };
}
