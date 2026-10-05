/**
 * `POST /api/play/events` – jedna událost herní smyčky (P27D T4, B4).
 *
 * Tělo: `{ name, versionId, session }`, u `share` ještě volitelné `withClip`
 * (boolean, P29D T2) a `dare` (boolean, P36B T6), a nic jiného (`src/play/loop-events.ts`);
 * klíč navíc, věta nebo volný text je 400. Odpověď `204`. Nic neplatí a nic
 * nezakládá, přesto má vlastní strop frekvence a páku `sessions` – kdo vypne
 * zakládání, nechce ani zápis statistik.
 */

import { loopCountersOf, readLoopEvent } from '@/play/loop-events';
import { killState } from '@/server/kill-switch';
import { ownerIdentityRejection } from '@/server/owner-identity';
import { rateLimitCode, takeRateSlot } from '@/server/rate-limit';

import { recordLoopEvent } from '../_events';
import { fail, readJsonBody } from '../_errors';
import { callerOf, store, voterOf } from '../_publish';

export async function POST(request: Request): Promise<Response> {
  if ((await killState(process.env)).sessions) return fail(503, 'DISABLED', 'this part of PLAY is switched off right now');
  // Táž brána identity jako ostatní dveře PLAY (`admit` v `_publish.ts`), jen s vlastním oknem.
  const identity = ownerIdentityRejection(request);
  if (identity !== null) return identity;
  const slot = takeRateSlot('play/events', callerOf(request));
  if (!slot.allowed) {
    const code = rateLimitCode(slot);
    return fail(429, code, code === 'SERVER_AT_CAPACITY' ? 'this instance is at capacity right now' : 'too many requests from this client', { 'retry-after': String(slot.retryAfterSeconds) });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const event = readLoopEvent(body.value);
  if (event === null) return fail(400, 'BAD_REQUEST', 'an event is { name, versionId, session }, plus optional booleans withClip and dare on share, and nothing else');
  recordLoopEvent(event);
  // Dohrání a přeskočení řadí feed (P36B T9), pokus a výhra dávají „clear rate“ (P37C T5):
  // jen hra, která v úložišti je, a jeden hlas volajícího za den na čítač.
  const counters = loopCountersOf(event);
  if (counters.length > 0) await store().countLoop(event.versionId, counters, voterOf(request));
  return new Response(null, { status: 204 });
}
