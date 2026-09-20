/**
 * Společná cesta spec → publikovaná verze (P23-C T3). Volají ji obě dveře,
 * které něco publikují: `POST /api/play/games` i `POST …/:id/remix`.
 *
 * Pořadí je smlouva: nejdřív brány, které nic nestojí (vypínač, strop
 * frekvence, tvar těla), pak rodič, pak kompilace, pak zápis. Odmítnutí
 * v kterémkoli kroku znamená, že do úložiště nešel ani bajt.
 *
 * **Táž hra podruhé je `200`, ne `409`.** `versionId` je hash obsahu, takže
 * když už pod ním něco leží, je to táž hra – jen s jiným `createdAt`. Čte se
 * proto dřív, než se píše; `conflict` z úložiště pak zbývá jen pro rozdíl
 * v tom, co do hashe nejde (zpráva o kvalitě), a to je poctivých 409.
 */

import { canonicalHash } from '@/ir/worlddoc';
import type { CompileGameReason } from '@/play/contracts';
import { type GameSpecV1, readGameSpec } from '@/play/spec';
import { type PublishedGame, type VersionStore, VersionStoreUnavailable, sealVersion, versionStoreFromEnv } from '@/play/version';
import { callerKey, rateLimitCode, takeRateSlot } from '@/server/rate-limit';
import { killState } from '@/server/kill-switch';

import { getCompiler } from './_compiler';
import { fail, VERSION_ID_PATTERN } from './_errors';
import { stubReport } from './_report';

/** Nejdelší věta, kterou dveře vezmou. Delší je 413, ne oříznutí. */
export const MAX_SENTENCE_CHARS = 500;

/** Semínko je celé číslo 1..2^31; bez něj se odvodí z obsahu – nikde `Math.random`. */
export const MAX_SEED = 2 ** 31;

export function seedFrom(value: unknown): number {
  return (Number.parseInt(canonicalHash(value).slice(0, 8), 16) % (MAX_SEED - 1)) + 1;
}

export function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEED;
}

export interface Published {
  readonly status: 200 | 201;
  readonly game: PublishedGame;
}

export type PublishResult = { readonly ok: true; readonly value: Published } | { readonly ok: false; readonly response: Response };

/** Brány, které platí pro každý zápis: vypínač a strop frekvence. `null` = projdi. */
export async function admit(request: Request): Promise<Response | null> {
  if ((await killState(process.env)).sessions) return fail(503, 'DISABLED', 'publishing games is switched off right now');
  const slot = takeRateSlot('play', callerKey(request));
  if (!slot.allowed) {
    const code = rateLimitCode(slot);
    return fail(
      429,
      code,
      code === 'SERVER_AT_CAPACITY' ? 'this instance is at capacity right now' : 'too many requests from this client',
      { 'retry-after': String(slot.retryAfterSeconds) },
    );
  }
  return null;
}

export function store(): VersionStore {
  return versionStoreFromEnv(process.env);
}

/** Rodič musí existovat dřív, než se kvůli němu něco kompiluje. */
export async function parentOf(versions: VersionStore, parentId: string): Promise<PublishedGame | null> {
  return VERSION_ID_PATTERN.test(parentId) ? versions.get(parentId) : null;
}

const COMPILE_MESSAGE: Readonly<Record<CompileGameReason, string>> = {
  SPEC_REJECTED: 'the game description was rejected',
  MECHANIC_UNSUPPORTED: 'the game uses a mechanic this build cannot compile yet',
  LAYOUT_FAILED: 'the game could not be laid out on the grid',
  WORLD_REJECTED: 'the game world did not pass verification',
  UNWINNABLE: 'no winning path was found for this game',
};

/** Posoudí spec od cizího, zkompiluje, zapečetí a zapíše. */
export async function publishSpec(
  versions: VersionStore,
  input: unknown,
  seed: number,
  parentId: string | null,
): Promise<PublishResult> {
  const read = readGameSpec(input);
  if (!read.ok) return { ok: false, response: fail(422, 'SPEC_REJECTED', `${read.reason}: ${read.issues[0] ?? 'the game description was rejected'}`) };
  return publishReadSpec(versions, read.value, seed, parentId);
}

export async function publishReadSpec(
  versions: VersionStore,
  spec: GameSpecV1,
  seed: number,
  parentId: string | null,
): Promise<PublishResult> {
  const compiled = getCompiler()(spec, seed);
  if (!compiled.ok) return { ok: false, response: fail(422, compiled.reason, COMPILE_MESSAGE[compiled.reason]) };

  const version = sealVersion(compiled.value, parentId, Date.now);
  const game: PublishedGame = { version, spec, blueprint: compiled.value.blueprint, report: stubReport(compiled.value) };

  const existing = await versions.get(version.versionId);
  if (existing !== null) return { ok: true, value: { status: 200, game: existing } };

  let outcome: 'stored' | 'exists' | 'conflict';
  try {
    outcome = await versions.put(game);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable)
      return { ok: false, response: fail(503, 'STORE_UNAVAILABLE', 'the game could not be saved right now') };
    throw thrown;
  }
  if (outcome === 'conflict')
    return { ok: false, response: fail(409, 'VERSION_CONFLICT', 'a different game already holds this version id') };
  return { ok: true, value: { status: outcome === 'stored' ? 201 : 200, game } };
}

/** Odpověď obou publikujících dveří: kam jít hrát. */
export function publishedResponse(published: Published): Response {
  const { version, spec } = published.game;
  return Response.json(
    {
      versionId: version.versionId,
      title: version.title,
      parentId: version.parentId,
      archetype: spec.archetype,
      url: `/play/${version.versionId}`,
    },
    { status: published.status },
  );
}
