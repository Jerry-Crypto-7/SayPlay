/**
 * Vydání identity hráče (P44B T3) pro dveře, které ji smí založit: `GET /api/play/me`
 * a výzva Dare (T5). Strop nových identit na volajícího a hodinu drží sybil
 * (debata T1); id jde ven jen v hlavičce `set-cookie`, nikdy v těle.
 */

import { createHash } from 'node:crypto';

import { type VersionStore, VersionStoreUnavailable } from '@/play/version';
import { issuePlayer, playerCookie } from '@/server/player-identity';

import { fail } from './_errors';
import { directorCallerOf, UNTRUSTED_DIRECTOR_CALLER } from './_publish';

/**
 * Kolik nových identit smí jeden volající dostat za hodinu. Hodina, ne den (nález revize T3-1):
 * jedno zařízení za sdílenou adresou (Wi-Fi na místě, NAT operátora) by jinak denní strop
 * vyčerpalo všem za sebou za vteřinu – takhle nejvýš na hodinu.
 */
export const NEW_PLAYERS_PER_HOUR = 20;

/** Denní strop na důvěryhodnou adresu (T3b): samotný hodinový by jedné adrese pustil 480 identit za den. */
export const NEW_PLAYERS_PER_DAY = 60;

/**
 * Strop společného koše za hodinu (T3b): mimo Vercel sdílejí všichni jeden koš a 20 požadavků
 * jednoho cizince by zavřelo hru celé místnosti na hodinu. Denní strop koš nemá – zavřel by ji na den.
 */
export const NEW_PLAYERS_PER_HOUR_SHARED = 100;

/**
 * Hlas volajícího pro strop jen z důvěryhodného konce (nález revize T3-1, blokující): mimo
 * Vercel `x-forwarded-for` píše volající a každou novou hodnotou by si strop obnovil. Takoví
 * volající sdílejí jeden koš – týž kompromis jako denní počet režiséra (`directorCallerOf`).
 */
function newPlayerQuotaOf(request: Request): { readonly voter: string; readonly perHour: number; readonly perDay: number | null } {
  const caller = directorCallerOf(request);
  const voter = createHash('sha256').update(caller).digest('hex').slice(0, 16);
  return caller === UNTRUSTED_DIRECTOR_CALLER ? { voter, perHour: NEW_PLAYERS_PER_HOUR_SHARED, perDay: null } : { voter, perHour: NEW_PLAYERS_PER_HOUR, perDay: NEW_PLAYERS_PER_DAY };
}

export type Minted = { readonly ok: true; readonly id: string; readonly setCookie: string } | { readonly ok: false; readonly response: Response };

export async function mintPlayer(request: Request, versions: VersionStore, secret: string): Promise<Minted> {
  let allowed: boolean;
  try {
    const { voter, perHour, perDay } = newPlayerQuotaOf(request);
    allowed = await versions.countNewPlayer(voter, perHour, perDay);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return { ok: false, response: fail(503, 'STORE_UNAVAILABLE', 'player names are unavailable right now') };
    throw thrown;
  }
  if (!allowed) return { ok: false, response: fail(429, 'NEW_PLAYER_QUOTA', 'too many new players from this network right now; try again later', { 'retry-after': '3600' }) };
  const { id, value } = issuePlayer(secret);
  return { ok: true, id, setCookie: playerCookie(value, request) };
}

export function identityUnavailable(): Response {
  return fail(503, 'IDENTITY_UNAVAILABLE', 'player names are switched off on this server');
}
