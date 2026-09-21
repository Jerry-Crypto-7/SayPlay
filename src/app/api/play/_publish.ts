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
import { type PublishedGame, type PutOutcome, type VersionStore, VersionStoreUnavailable, sealVersion, versionStoreFromEnv } from '@/play/version';
import { callerKey, rateLimitCode, takeRateSlot, trustedCallerKey } from '@/server/rate-limit';
import { killState, type KillState } from '@/server/kill-switch';
import { ownerIdentityRejection } from '@/server/owner-identity';

import { getCompiler } from './_compiler';
import { fail, VERSION_ID_PATTERN } from './_errors';
import { reportFor } from './_report';

/** Nejdelší věta, kterou dveře vezmou. Delší je 413, ne oříznutí. */
export const MAX_SENTENCE_CHARS = 500;

/** Semínko je celé číslo 1..2^31; bez něj se odvodí z obsahu – nikde `Math.random`. */
export const MAX_SEED = 2 ** 31;

export function seedFrom(value: unknown): number {
  return (Number.parseInt(canonicalHash(value).slice(0, 8), 16) % (MAX_SEED - 1)) + 1;
}

/**
 * Semínka, která dveře zkusí, když si volající žádné nevybral: odvozené a za
 * ním tři další, pořád deterministicky z něj. Rozvržení na některém semínku
 * umí vyjít nevyhratelné (naměřeno 21. 9. 2026: návrh „fragile cake" na
 * semínku z věty prohraje ve 6. tiku, na semínkách 1–3 vyhraje) – věta se
 * kvůli tomu nemá stát chybou. Semínko zvolené volajícím se nemění nikdy.
 */
export function derivedSeeds(base: number): readonly number[] {
  return [base, ...[1, 2, 3].map((attempt) => seedFrom({ base, attempt }))];
}

/** Důvody kompilace, které závisí na rozvržení, a proto má smysl zkusit jiné semínko. */
const SEED_DEPENDENT: ReadonlySet<CompileGameReason> = new Set(['UNWINNABLE', 'LAYOUT_FAILED']);

export function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEED;
}

export interface Published {
  readonly status: 200 | 201;
  readonly game: PublishedGame;
}

export type PublishResult = { readonly ok: true; readonly value: Published } | { readonly ok: false; readonly response: Response };

/**
 * Brány, které platí pro každé dveře: vypínač, ověřená identita za proxy a strop
 * frekvence. `null` = projdi. Zápis čte páku `sessions` (zakládání nového),
 * čtení páku `snapshots` (vydávání hotového – vypne ji jedině `all`).
 *
 * **Klíč stropu je z důvěryhodného konce, ne z `x-forwarded-for`.** Tu hlavičku
 * píše volající; s ní by si útočník kvótu resetoval každým požadavkem a naopak
 * uměl vyčerpat cizí (nález revize T3, táž třída jako `rate-limit.ts` 6. 9.).
 */
export async function admit(request: Request, lever: keyof KillState = 'sessions'): Promise<Response | null> {
  if ((await killState(process.env))[lever]) return fail(503, 'DISABLED', 'this part of PLAY is switched off right now');
  const identity = ownerIdentityRejection(request);
  if (identity !== null) return identity;
  const slot = takeRateSlot('play', trustedCallerKey(request) ?? callerKey(request));
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

export type SpecRead = { readonly ok: true; readonly value: GameSpecV1 } | { readonly ok: false; readonly response: Response };

/**
 * Spec od cizího projde `readGameSpec` dřív, než se z něj cokoli počítá –
 * i semínko. Hash nad surovým tělem by rekurzí spadl na hluboko vnořeném poli
 * (nález revize T3); validovaný spec má hloubku danou schématem.
 */
export function readSpecOrFail(input: unknown): SpecRead {
  const read = readGameSpec(input);
  if (!read.ok) return { ok: false, response: fail(422, 'SPEC_REJECTED', `${read.reason}: ${read.issues[0] ?? 'the game description was rejected'}`) };
  return { ok: true, value: read.value };
}

/**
 * Denní strop a zdraví úložiště **před** placeným voláním: věta, kterou by
 * úložiště stejně odmítlo, nesmí nejdřív zaplatit model (nález revize T1).
 * `null` = publikovat se dá.
 */
export async function publishRefusal(versions: VersionStore): Promise<Response | null> {
  try {
    if (await versions.canPublish()) return null;
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the game could not be saved right now');
    throw thrown;
  }
  return fail(429, 'PUBLISH_QUOTA', "today's publishing quota is used up; try again tomorrow", { 'retry-after': '3600' });
}

export async function publishReadSpec(
  versions: VersionStore,
  spec: GameSpecV1,
  seeds: readonly number[],
  parentId: string | null,
): Promise<PublishResult> {
  const compile = getCompiler();
  let compiled = compile(spec, seeds[0]);
  for (const seed of seeds.slice(1)) {
    if (compiled.ok || !SEED_DEPENDENT.has(compiled.reason)) break;
    compiled = compile(spec, seed);
  }
  if (!compiled.ok) return { ok: false, response: fail(422, compiled.reason, COMPILE_MESSAGE[compiled.reason]) };

  // Hra, jejíž keypoint, svědek, replay nebo rozpočet neprošel, se nepublikuje –
  // odkaz by vedl na hru, která nedělá, co slibuje.
  const report = reportFor(compiled.value);
  if (!report.publishEligible) {
    const keypoints = report.keypoints.filter((keypoint) => !keypoint.passed).map((keypoint) => keypoint.assertionId);
    return { ok: false, response: fail(422, 'NOT_PUBLISHABLE', 'the game did not pass its own checks', undefined, { keypoints }) };
  }

  const version = sealVersion(compiled.value, parentId, Date.now);
  const game: PublishedGame = { version, spec, blueprint: compiled.value.blueprint, report };

  const existing = await versions.get(version.versionId);
  if (existing !== null) return { ok: true, value: { status: 200, game: existing } };

  let outcome: PutOutcome;
  try {
    outcome = await versions.put(game);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable)
      return { ok: false, response: fail(503, 'STORE_UNAVAILABLE', 'the game could not be saved right now') };
    throw thrown;
  }
  if (outcome === 'quota')
    return { ok: false, response: fail(429, 'PUBLISH_QUOTA', "today's publishing quota is used up; try again tomorrow", { 'retry-after': '3600' }) };
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
