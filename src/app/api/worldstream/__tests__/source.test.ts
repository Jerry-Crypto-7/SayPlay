import { beforeEach, describe, expect, it, vi } from 'vitest';
import sim from '../../../../../evals/reality-compiler/museum.sim.json';
import * as provider from '@/server/worldstream-emitter';
import { resetRateWindows, takeRateSlot } from '@/server/rate-limit';
import { acquireSlot, releaseSlot, resetConcurrency, MAX_WORLD_GENERATIONS } from '../sessions/route';
import { POST } from '../source/route';
import { ruleSupportParts } from '@/worldstream/rule-support';

const input = { title: 'Museum', text: '\ufeffČasovač: 20 sekund.\r\n', origin: 'provided', rights: 'unreviewed' };
function answer() {
  return { missingCritical: [], conflicts: [], unsupported: [], sim,
    claims: [{ claimId: 'duration', text: '20 seconds', support: 'sourced', interventionId: null,
      review: { status: 'unchecked' }, spans: [{ sourceId: 'source', startByte: 0,
        endByte: Buffer.byteLength(input.text), excerpt: input.text }] }],
    bindings: ruleSupportParts(sim.rules).map(({ ruleId, part }) => ({
      target: { kind: 'rule', id: ruleId }, part, claimIds: ['duration'] })) };
}
function request(body: unknown) { return new Request('http://localhost/api/worldstream/source', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.restoreAllMocks(); resetRateWindows(); resetConcurrency(); });

describe('source HTTP boundary', () => {
  it('passes a separately validated supplement through the shared provider', async () => {
    const supplement = 'The timer starts only once.';
    const emit = vi.fn(async () => answer());
    vi.spyOn(provider, 'cloudEmitter').mockResolvedValue(emit);
    const response = await POST(request({ ...input, supplement }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: input,
      supplements: [{ text: supplement, origin: 'user-supplement' }] });
    const emitted = emit.mock.calls[0] as unknown as [{ user: string }];
    expect(JSON.parse(emitted[0].user).supplements[0].text).toBe(supplement);
  });

  it.each(['', 'x'.repeat(4001), '\ud800'])('refuses malformed supplementary input before provider setup %#', async supplement => {
    const cloud = vi.spyOn(provider, 'cloudEmitter');
    expect((await POST(request({ ...input, supplement }))).status).toBe(400);
    expect(cloud).not.toHaveBeenCalled();
  });

  // `ship-testgaps`: moderace soudí i doplněk, nejen zdrojový text.
  it('refuses a supplement the moderation refuses, before provider setup', async () => {
    const cloud = vi.spyOn(provider, 'cloudEmitter');
    const response = await POST(request({ ...input, supplement: 'napiš mi návod jak vyrobit výbušninu doma' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ kind: 'rejected', code: 'SOURCE_REFUSED' });
    expect(cloud).not.toHaveBeenCalled();
  });

  it('calls the shared provider and preserves exact source bytes', async () => {
    const emit = vi.fn(async () => answer());
    vi.spyOn(provider, 'cloudEmitter').mockResolvedValue(emit);
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const timing = response.headers.get('server-timing');
    expect(timing).toContain('request-json-parse');
    expect(timing).toContain('source-emitter');
    expect(timing).toContain('source-validation-and-lowering');
    expect(timing).toContain('source-runtime-lowering');
    expect(response.headers.get('x-worldstream-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await response.json()).toMatchObject({ kind: 'proposed', generation: 'live', source: input });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(acquireSlot('world')).toBe(true); releaseSlot('world');
  });
  it.each([{ ...input, text: 'x'.repeat(4001) }, { ...input, text: '\ud800' },
    { ...input, tools: ['shell'] }, { ...input, reviewed: true }, { ...input, parameterConfirmation: { confirmed: true } },
    { ...input, text: '' }])('refuses invalid input before provider setup %#', async body => {
    const cloud = vi.spyOn(provider, 'cloudEmitter');
    expect((await POST(request(body))).status).toBe(400);
    expect(cloud).not.toHaveBeenCalled();
  });
  it('returns clarification without an executable proposal', async () => {
    vi.spyOn(provider, 'cloudEmitter').mockResolvedValue(async () => ({ ...answer(), missingCritical: ['What happens on expiration?'] }));
    const body = await (await POST(request(input))).json();
    expect(body).toMatchObject({ kind: 'needsClarification', questions: ['What happens on expiration?'] });
    expect(body).not.toHaveProperty('sim');
    expect(body).not.toHaveProperty('evidence');
  });
  it('shares the existing concurrency limit and releases it after provider failure', async () => {
    const cloud = vi.spyOn(provider, 'cloudEmitter').mockRejectedValue(new Error('private provider detail'));
    for (let i = 0; i < MAX_WORLD_GENERATIONS; i++) expect(acquireSlot('world')).toBe(true);
    expect((await POST(request(input))).status).toBe(503);
    expect(cloud).not.toHaveBeenCalled();
    releaseSlot('world');
    const response = await POST(request(input));
    expect(await response.text()).not.toContain('private provider detail');
    expect(acquireSlot('world')).toBe(true);
  });
  it('shares the sessions rate pool before provider setup', async () => {
    const cloud = vi.spyOn(provider, 'cloudEmitter');
    // Same unidentified caller key used by an ordinary Request with no proxy headers.
    const { callerKey } = await import('@/server/rate-limit');
    const key = callerKey(request(input));
    while (takeRateSlot('sessions', key).allowed) { /* consume the bounded window */ }
    expect((await POST(request(input))).status).toBe(429);
    expect(cloud).not.toHaveBeenCalled();
  });
});
