/**
 * Vydání identity hráče (P44B T3) pro dveře, které ji smí založit: `GET /api/play/me`
 * a výzva Dare (T5). Strop nových identit na volajícího a den drží sybil
 * (debata T1); id jde ven jen v hlavičce `set-cookie`, nikdy v těle.
 */

import { type VersionStore, VersionStoreUnavailable } from '@/play/version';
import { issuePlayer, playerCookie } from '@/server/player-identity';

import { fail } from './_errors';
import { voterOf } from './_publish';

/** Kolik nových identit smí jeden volající dostat za den. */
export const NEW_PLAYERS_PER_DAY = 20;

export type Minted = { readonly ok: true; readonly id: string; readonly setCookie: string } | { readonly ok: false; readonly response: Response };

export async function mintPlayer(request: Request, versions: VersionStore, secret: string): Promise<Minted> {
  let allowed: boolean;
  try {
    allowed = await versions.countNewPlayer(voterOf(request), NEW_PLAYERS_PER_DAY);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return { ok: false, response: fail(503, 'STORE_UNAVAILABLE', 'player names are unavailable right now') };
    throw thrown;
  }
  if (!allowed) return { ok: false, response: fail(429, 'NEW_PLAYER_QUOTA', "today's new player quota for this network is used up; try again tomorrow", { 'retry-after': '3600' }) };
  const { id, value } = issuePlayer(secret);
  return { ok: true, id, setCookie: playerCookie(value, request) };
}

export function identityUnavailable(): Response {
  return fail(503, 'IDENTITY_UNAVAILABLE', 'player names are switched off on this server');
}
