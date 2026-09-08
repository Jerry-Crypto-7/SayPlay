import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readBody, bodyRefusalResponse } from '@/http/body';
import { killState } from '@/server/kill-switch';
import { moderatePrompt } from '@/server/moderation';
import { callerKey, trustedCallerKey, takeRateSlot, rateLimitedResponse } from '@/server/rate-limit';
import { createSourceSnapshot } from '@/worldstream/evidence';
import { runSourceProposal } from '@/worldstream/sessions';
import { acquireSlot, releaseSlot } from '../sessions/route';


const bodySchema = z.strictObject({ text: z.string(), title: z.string().min(1).max(256),
  origin: z.enum(['own', 'provided']), rights: z.enum(['owned', 'licensed', 'unreviewed']) });
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Source is data. No request field grants tools, review, or budget authority.
 * Reuses the sessions rate/concurrency pool and the T7 spend-controlled emitter. */
export async function handleSourceRequest(request: Request, propose = runSourceProposal, generation: 'live' | 'fixture' = 'live') {
  const requestId = randomUUID();
  const fail = (code: string, status = 400) => response({ kind: 'rejected', code }, status);
  if ((await killState(process.env)).sessions) return fail('SESSIONS_DISABLED', 503);
  const rate = takeRateSlot('sessions', trustedCallerKey(request) ?? callerKey(request));
  if (!rate.allowed) return rateLimitedResponse(requestId, rate);
  try {
    const raw = await readBody(request);
    if (!raw.ok) return bodyRefusalResponse(requestId, raw);
    let json: unknown;
    try { json = JSON.parse(raw.text); } catch { return fail('BAD_REQUEST'); }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return fail('BAD_REQUEST');
    const input = { ...parsed.data, sourceId: 'source', mediaType: 'text/plain' };
    if (!(await createSourceSnapshot(input)).ok) return fail('SOURCE_INVALID');
    if (!moderatePrompt(parsed.data.text).ok) return fail('SOURCE_REFUSED');
    if (!acquireSlot('world')) return fail('BUSY', 503);
    try {
      const result = await propose(input, requestId);
      return response({ ...result, generation }, result.kind === 'rejected' ? 422 : 200);
    } finally { releaseSlot('world'); }
  } catch { return fail('SOURCE_UNAVAILABLE', 503); }
}
