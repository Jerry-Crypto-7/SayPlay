/**
 * Jediný tvar chyby veřejných dveří PLAY: `{ error: { code, message } }`.
 *
 * Nikdy stack, nikdy cesta, nikdy adresa úložiště – dveře jsou bez přihlášení
 * a text odpovědi čte cizí člověk i cizí skript. Kód je stabilní část smlouvy
 * (`docs/play/shell.md`), zpráva je věta pro člověka a smí se měnit.
 */

import { type BodyFailure, bodyRefusal, readBody } from '@/http/body';
import { moderatePrompt, PLAY_MODERATION } from '@/server/moderation';

export type PlayErrorCode =
  | 'BAD_REQUEST'
  | 'SENTENCE_REJECTED'
  | 'BODY_TOO_LARGE'
  | 'BODY_TIMEOUT'
  | 'TOO_MANY_BODY_READS'
  | 'SPEC_REJECTED'
  | 'MECHANIC_UNSUPPORTED'
  | 'LAYOUT_FAILED'
  | 'WORLD_REJECTED'
  | 'UNWINNABLE'
  | 'NOT_PUBLISHABLE'
  | 'NOT_FOUND'
  | 'UNKNOWN_PARENT'
  | 'VERSION_CONFLICT'
  | 'DISABLED'
  | 'TOO_MANY_REQUESTS'
  | 'PUBLISH_QUOTA'
  | 'DARE_REJECTED'
  | 'DARE_QUOTA'
  | 'SERVER_AT_CAPACITY'
  | 'STORE_UNAVAILABLE';

export function fail(
  status: number,
  code: PlayErrorCode,
  message: string,
  headers?: Record<string, string>,
  extra?: Readonly<Record<string, unknown>>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status, headers });
}

/** Hra, která není, a id, které nemůže být, dostávají tutéž odpověď – ať se z rozdílu nedá nic vyčíst. */
export function notFound(): Response {
  return fail(404, 'NOT_FOUND', 'this game does not exist or has expired');
}

/** Znění z kitu (`docs/brand/docs/11-voice-copy.md`, Errors → Blocked content); UI ho ukazuje beze změny. */
export const SENTENCE_BLOCKED = "We can't make that one. Try a different idea.";

/**
 * Věta na zakázané téma (P40 T1): 422 dřív, než se sáhne na úložiště, čtečku
 * nebo režiséra – feed `/play` je veřejný. Pravidla `PLAY_MODERATION`
 * (`src/server/moderation.ts`), lexikální, bez placeného API.
 */
export function refuseSentence(sentence: string): Response | null {
  return moderatePrompt(sentence, PLAY_MODERATION).ok ? null : fail(422, 'SENTENCE_REJECTED', SENTENCE_BLOCKED);
}

/** Tvar id verze: hex z `canonicalHash`. Cokoli jiného je 404 dřív, než se sáhne na úložiště. */
export const VERSION_ID_PATTERN = /^[a-f0-9]{8,64}$/;

export type BodyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly response: Response };

/**
 * Přečte JSON tělo přes sdílený čtecí kus `src/http/body.ts` – strop 64 kB
 * v bajtech, deadline 5 s a počet souběžných čtení na volajícího i instanci.
 * Dřív se tělo nejdřív celé načetlo a teprve pak měřilo (nález revize T3):
 * nad stropem se teď nedrží nic. `TOO_LARGE` si dveře překládají na svůj
 * `BODY_TOO_LARGE` – ten už je ve smlouvě (`docs/play/shell.md`).
 */
export async function readJsonBody(request: Request): Promise<BodyRead> {
  let raw;
  try {
    raw = await readBody(request);
  } catch {
    return { ok: false, response: fail(400, 'BAD_REQUEST', 'the request body could not be read') };
  }
  if (!raw.ok) return { ok: false, response: refuseBody(raw) };
  try {
    return { ok: true, value: JSON.parse(raw.text) as unknown };
  } catch {
    return { ok: false, response: fail(400, 'BAD_REQUEST', 'the request body is not JSON') };
  }
}

function refuseBody(failure: BodyFailure): Response {
  const refusal = bodyRefusal(failure);
  return fail(
    refusal.status,
    refusal.code === 'PAYLOAD_TOO_LARGE' ? 'BODY_TOO_LARGE' : refusal.code,
    refusal.message,
    refusal.retryAfterSeconds === undefined ? undefined : { 'retry-after': String(refusal.retryAfterSeconds) },
  );
}
