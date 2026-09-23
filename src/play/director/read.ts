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

/** Slovníky ve `verification`, které přísné schéma posílá jako seznam dvojic `{key, value}`. */
const RECORD_KEYS = new Set(['counters', 'flags', 'entityStates', 'locked', 'placeAt']);

function restore(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    if (RECORD_KEYS.has(key)) return Object.fromEntries(value.filter(isRecord).map((pair) => [String(pair.key), restore(pair.value)]));
    return value.map((item) => restore(item));
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([name, item]) => [name, restore(item, name)]));
  return value;
}

/**
 * Odpověď v přísném schématu (`answer-schema.ts`, P26 T6) → obyčejný spec:
 * bez `plan`, bez polí `null`, slovníky zpátky z dvojic. Arkáda `verification`
 * nepíše – dostane „hra jde vyhrát“, kterou dokazuje robot. Jiné tělo
 * (větev bez schématu) projde beze změny.
 */
export function unwrapAnswer(body: unknown): unknown {
  if (!isRecord(body) || typeof body.plan !== 'string' || !isRecord(body.spec)) return body;
  const spec = restore(body.spec) as Record<string, unknown>;
  // Mřížka je v návrhu bez `control`; stejný tvar drží porovnání „model vrátil návrh“.
  if (spec.control === 'tap_go') delete spec.control;
  if (spec.verification === undefined) spec.verification = [{ id: 'wins', kind: 'reachability', assert: { runState: 'won' } }];
  return spec;
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
  const result = readGameSpec(body);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.issues.join('; ') };
  return { ok: true, spec: result.value };
}
