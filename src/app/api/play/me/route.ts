/**
 * `GET|PUT /api/play/me` – kdo hraje (P44B T3). `GET` vrátí `{ nickname }`
 * hráče z podepsané cookie `sp_player`; bez platné cookie vydá novou (strop
 * `NEW_PLAYERS_PER_DAY` na volajícího). `PUT { nickname }` jméno změní, jen
 * majiteli platné cookie a jen s `content-type: application/json` – cizí
 * stránka takový požadavek bez preflightu neodešle a `SameSite=Lax` cookie
 * k němu nepřibalí. Tělo odpovědi nikdy nenese id hráče ani hodnotu cookie.
 */

import { z } from 'zod';

import { readNickname, shownNickname } from '@/play/player/nickname';
import { VersionStoreUnavailable } from '@/play/version';
import { identitySecret, playerOf } from '@/server/player-identity';
import { rateLimitCode, takeRateSlot } from '@/server/rate-limit';

import { fail, readJsonBody } from '../_errors';
import { identityUnavailable, mintPlayer } from '../_player';
import { admit, callerOf, store } from '../_publish';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const refused = await admit(request);
  if (refused !== null) return refused;
  const secret = identitySecret();
  if (secret === null) return identityUnavailable();
  const versions = store();
  const known = playerOf(request);
  if (known !== null) return Response.json({ nickname: shownNickname(known, (await versions.getPlayer(known))?.nickname) }, { headers: NO_STORE });
  const minted = await mintPlayer(request, versions, secret);
  if (!minted.ok) return minted.response;
  return Response.json({ nickname: shownNickname(minted.id, null) }, { headers: { ...NO_STORE, 'set-cookie': minted.setCookie } });
}

const bodySchema = z.object({ nickname: z.unknown() });

export async function PUT(request: Request): Promise<Response> {
  const refused = await admit(request);
  if (refused !== null) return refused;
  if (identitySecret() === null) return identityUnavailable();
  const player = playerOf(request);
  if (player === null) return fail(403, 'PLAYER_REQUIRED', 'play a game first, then pick your name');
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    return fail(415, 'BAD_REQUEST', 'send the name as JSON');
  const slot = takeRateSlot('play/me', callerOf(request));
  if (!slot.allowed) {
    const code = rateLimitCode(slot);
    return fail(429, code, code === 'SERVER_AT_CAPACITY' ? 'this instance is at capacity right now' : 'too many requests from this client', { 'retry-after': String(slot.retryAfterSeconds) });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  const read = readNickname(parsed.success ? parsed.data.nickname : undefined);
  // Znění z kitu (`docs/brand/docs/11-voice-copy.md`); UI je ukazuje beze změny.
  if (!read.ok)
    return read.reason === 'blocked' ? fail(422, 'CONTENT_REJECTED', "We can't use that name. Try another one.") : fail(400, 'BAD_REQUEST', 'Use 2–20 letters or numbers.');
  try {
    await store().putPlayer(player, { nickname: read.nickname });
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the name could not be saved right now');
    throw thrown;
  }
  return Response.json({ nickname: read.nickname }, { headers: NO_STORE });
}
