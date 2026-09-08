import { beforeEach, describe, expect, it, vi } from 'vitest';
import sim from '../../../../../evals/reality-compiler/museum.sim.json';
import * as provider from '@/server/worldstream-emitter';
import { resetRateWindows, takeRateSlot } from '@/server/rate-limit';
import { acquireSlot, releaseSlot, resetConcurrency, MAX_WORLD_GENERATIONS } from '../sessions/route';
import { POST } from '../source/route';

const input = { title: 'Museum', text: '\ufeffČasovač: 20 sekund.\r\n', origin: 'provided', rights: 'unreviewed' };
function answer() {
  return { missingCritical: [], conflicts: [], unsupported: [], sim,
    claims: [{ claimId: 'duration', text: '20 seconds', support: 'sourced', interventionId: null,
      review: { status: 'unchecked' }, spans: [{ sourceId: 'source', startByte: 0,
        endByte: Buffer.byteLength(input.text), excerpt: input.text }] }],
    bindings: Object.keys(sim.rules).map(id => ({ bindingId: `binding.${id}`, target: { kind: 'rule', id }, claimIds: ['duration'] })) };
}
function request(body: unknown) { return new Request('http://localhost/api/worldstream/source', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.restoreAllMocks(); resetRateWindows(); resetConcurrency(); });

describe('source HTTP boundary', () => {
  it('calls the shared provider and preserves exact source bytes', async () => {
    const emit = vi.fn(async () => answer());
    vi.spyOn(provider, 'cloudEmitter').mockResolvedValue(emit);
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ kind: 'proposed', generation: 'live', source: input });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(acquireSlot('world')).toBe(true); releaseSlot('world');
  });
  it.each([{ ...input, text: 'x'.repeat(4001) }, { ...input, text: '\ud800' },
    { ...input, tools: ['shell'] }, { ...input, reviewed: true }, { ...input, text: '' }])('refuses invalid input before provider setup %#', async body => {
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
