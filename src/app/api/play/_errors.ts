/**
 * Jediný tvar chyby veřejných dveří PLAY: `{ error: { code, message } }`.
 *
 * Nikdy stack, nikdy cesta, nikdy adresa úložiště – dveře jsou bez přihlášení
 * a text odpovědi čte cizí člověk i cizí skript. Kód je stabilní část smlouvy
 * (`docs/play/shell.md`), zpráva je věta pro člověka a smí se měnit.
 */

export type PlayErrorCode =
  | 'BAD_REQUEST'
  | 'BODY_TOO_LARGE'
  | 'SPEC_REJECTED'
  | 'MECHANIC_UNSUPPORTED'
  | 'LAYOUT_FAILED'
  | 'WORLD_REJECTED'
  | 'UNWINNABLE'
  | 'NOT_FOUND'
  | 'UNKNOWN_PARENT'
  | 'VERSION_CONFLICT'
  | 'DISABLED'
  | 'TOO_MANY_REQUESTS'
  | 'SERVER_AT_CAPACITY'
  | 'STORE_UNAVAILABLE';

export function fail(status: number, code: PlayErrorCode, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/** Hra, která není, a id, které nemůže být, dostávají tutéž odpověď – ať se z rozdílu nedá nic vyčíst. */
export function notFound(): Response {
  return fail(404, 'NOT_FOUND', 'this game does not exist or has expired');
}

/** Tvar id verze: hex z `canonicalHash`. Cokoli jiného je 404 dřív, než se sáhne na úložiště. */
export const VERSION_ID_PATTERN = /^[a-f0-9]{8,64}$/;

/** Nejvíc bajtů těla, které dveře přečtou. Spec má jednotky kB; věta 500 znaků. */
export const MAX_BODY_BYTES = 64 * 1024;

export type BodyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly response: Response };

/** Přečte JSON tělo s tvrdým stropem na velikost; obojí odmítnutí je vlastní odpověď, ne výjimka. */
export async function readJsonBody(request: Request): Promise<BodyRead> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: fail(413, 'BODY_TOO_LARGE', 'the request body is too large') };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: fail(400, 'BAD_REQUEST', 'the request body is not JSON') };
  }
}
