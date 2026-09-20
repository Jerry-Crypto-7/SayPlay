import {withSessionStorageResponse} from '@/server/session-persistence';
import {assertSessionStorageReady} from '@/worldstream/sessions';
import {ownerIdentityRejection} from '@/server/owner-identity';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readBody, bodyRefusalResponse } from '@/http/body';
import { killState } from '@/server/kill-switch';
import { callerKey, trustedCallerKey, takeRateSlot, rateLimitedResponse } from '@/server/rate-limit';
import { getSession, restoreComparisonOrigin } from '@/worldstream/sessions';

export const runtime = 'nodejs';
const schema = z.object({ simRevision: z.int().nonnegative(), lookRevision: z.int().nonnegative(), simHash: z.string().max(128) }).strict();
const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/** Uses only the origin recorded by a successful atomic comparison commit. */
async function handleDurablePOST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const requestId = randomUUID();
  if ((await killState(process.env)).refine) return fail(503, 'REFINE_DISABLED', 'Changing worlds is switched off right now.');
  const identityRejection=ownerIdentityRejection(request);
  if(identityRejection)return identityRejection;
  const slot = takeRateSlot('commit', trustedCallerKey(request) ?? callerKey(request));
  if (!slot.allowed) return rateLimitedResponse(requestId, slot);
  const raw = await readBody(request);
  if (!raw.ok) return bodyRefusalResponse(requestId, raw);
  let body: unknown;
  try { body = JSON.parse(raw.text); } catch { return fail(400, 'INVALID_REQUEST', 'Expected the accepted revision.'); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST', 'Expected only the accepted revision and simulation hash.');
  const { sessionId } = await context.params;
  const stored = getSession(sessionId);
  if (!stored) return fail(404, 'UNKNOWN_SESSION', 'This session is unavailable.');
  if (stored.session.phase === 'complete' || stored.session.phase === 'failed')
    return fail(409, 'SESSION_CLOSED', 'This session no longer takes changes.');
  const result = restoreComparisonOrigin(stored, parsed.data);
  if (!result.ok) return fail(409, result.code, result.detail);
  return Response.json({ outcome: 'RESTORED', acceptedBlueprint: result.blueprint });
}

export async function POST(...args:Parameters<typeof handleDurablePOST>):Promise<Response> {
  return withSessionStorageResponse(async()=>{assertSessionStorageReady();return handleDurablePOST(...args);});
}
