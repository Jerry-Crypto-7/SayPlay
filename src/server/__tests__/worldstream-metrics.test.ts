import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginPhase, observePhase, observePhaseAsync } from '../../model/phase-observer';
import { createServerMetrics, currentServerMetrics, serverPhaseObserver, withServerMetrics } from '../worldstream-metrics';
import { upstreamBranch, upstreamConfigFromEnv } from '../upstream';
import { after } from 'next/server';
import * as sessions from '../../worldstream/sessions';
import * as provider from '../worldstream-emitter';
import { resetRateWindows } from '../rate-limit';
import { POST, acquireSlot, MAX_WORLD_GENERATIONS, resetConcurrency } from '../../app/api/worldstream/sessions/route';
import { GET as sessionSnapshot } from '../../app/api/worldstream/sessions/[sessionId]/route';

vi.mock('next/server', () => ({ after: vi.fn((work: Promise<unknown>) => { void work.catch(() => undefined); }) }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(after).mockClear(); sessions.clearSessions(); resetRateWindows(); resetConcurrency(); });
describe('server phase diagnostics', () => {
  it('records an unexpected background rethrow as failed while preserving rejection and releasing the slot', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fault = new Error('private unexpected compiler failure');
    vi.spyOn(provider, 'cloudEmitter').mockResolvedValue(async () => ({}));
    vi.spyOn(sessions, 'runGeneration').mockRejectedValue(fault);
    const response = await POST(new Request('http://localhost/api/worldstream/sessions', {
      method: 'POST', body: JSON.stringify({ prompt: 'a salt flat with an iron mast', live: true }),
    }));
    expect(response.status).toBe(202);
    const background = vi.mocked(after).mock.calls.at(-1)?.[0];
    expect(background).toBeInstanceOf(Promise);
    await expect(background).rejects.toBe(fault);
    const entries = log.mock.calls.map(call => JSON.parse(call[0] as string));
    const phases = entries.filter(entry => entry.event === 'worldstream.server-timing').flatMap(entry => entry.phases)
      .filter(phase => phase.name === 'background-generation');
    expect(phases.some(phase => phase.outcome === 'failed' && phase.elapsedMs !== null)).toBe(true);
    expect(phases.some(phase => phase.outcome === 'completed')).toBe(false);
    expect(entries.filter(entry => entry.event === 'worldstream.generation'))
      .toEqual([expect.objectContaining({ outcome: 'failed', code: 'UNEXPECTED_REJECTION' })]);
    expect(JSON.stringify(entries)).not.toContain(fault.message);
    for (let i = 0; i < MAX_WORLD_GENERATIONS; i++) expect(acquireSlot('world')).toBe(true);
    expect(acquireSlot('world')).toBe(false);
  });

  /** P16 `T8-silentlive`: bez kódu poruchy se na produkci nedalo odlišit odmítnutí brány od nedoručeného proudu. */
  it.each([
    { name: 'a world', code: null, outcome: 'world', live: true },
    { name: 'a refused blueprint', code: 'BLUEPRINT_REJECTED', outcome: 'failed', live: true },
    { name: 'a prepared world', code: null, outcome: 'world', live: false },
  ] as const)('logs how the background generation ended: $name', async ({ code, outcome, live }) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(provider, 'cloudEmitter').mockResolvedValue(async () => ({}));
    vi.spyOn(sessions, 'runGeneration').mockImplementation(async (stored, _prompt, deps) => {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (code === null) return;
      deps.log?.(code, 'private gate detail');
      stored.fault = sessions.SESSION_FAULTS[code];
    });
    const response = await POST(new Request('http://localhost/api/worldstream/sessions', {
      method: 'POST', body: JSON.stringify({ prompt: 'a salt flat with an iron mast', live }),
    }));
    expect(response.status).toBe(202);
    await vi.mocked(after).mock.calls.at(-1)?.[0];
    const accepted = await response.json() as { requestId: string; sessionId: string };
    const snapshot = await sessionSnapshot(new Request('http://localhost'), { params: Promise.resolve({ sessionId: accepted.sessionId }) });
    const body = await snapshot.json();
    expect(body.generationMetrics).toMatchObject({ requestId: accepted.requestId, provenance: live ? 'live' : 'prepared' });
    expect(body.generationMetrics.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'background-generation', elapsedMs: expect.any(Number) }),
    ]));
    expect(JSON.stringify(body.generationMetrics)).not.toContain('private gate detail');
    const ended = log.mock.calls.map(call => JSON.parse(call[0] as string)).filter(entry => entry.event === 'worldstream.generation');
    expect(ended).toEqual([expect.objectContaining({
      requestId: accepted.requestId,
      provenance: live ? 'live' : 'prepared', outcome, code, fault: code === null ? null : sessions.SESSION_FAULTS[code],
    })]);
    // Generace trvá 25 ms, takže `ms` musí nést délku, ne jen nezápornou nulu.
    expect(ended[0].ms).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(ended)).not.toContain('private gate detail');
  });

  it.each(['{"ok":true}', 'not-json'])('separates upstream fetch, response body and model-output parse: %s', async output => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const config = upstreamConfigFromEnv({ WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://provider.invalid/messages', WORLDSMITH_MODEL_KEY: 'fixture-key', WORLDSMITH_USD_PER_MTOK_OUT: '25' });
    expect(config).not.toBeNull();
    let metrics!: ReturnType<typeof createServerMetrics>;
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: output }] })));
    await withServerMetrics('provider', 'source', async () => {
      metrics = currentServerMetrics()!;
      const branch = upstreamBranch(config!, fetchStub);
      const result = await branch.generate({ prompt: 'fixture', request: { model: 'fixture', system: 'fixture', user: 'fixture' } });
      expect(result.ok).toBe(output.startsWith('{'));
      return new Response(null);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const phases = metrics.snapshot().phases;
    expect(phases.map(p => p.name)).toEqual(['http-handler', 'provider-http-request', 'provider-response-json', 'provider-output-json-parse']);
    expect(phases.at(-1)?.outcome).toBe(output.startsWith('{') ? 'completed' : 'failed');
    expect(phases.every(p => p.elapsedMs !== null && p.elapsedMs >= 0)).toBe(true);
  });

  it('keeps pending durations null, measures actual boundaries, and caps retained phases', () => {
    let now = 10;
    const metrics = createServerMetrics('r', 'source', () => now);
    const finish = metrics.observe('source-emitter');
    now = 25;
    expect(metrics.snapshot().phases[0]).toMatchObject({ elapsedMs: null, outcome: 'pending' });
    expect(metrics.header()).toBe('');
    finish('failed');
    now = 100;
    finish('completed');
    expect(metrics.snapshot().phases[0]).toMatchObject({ elapsedMs: 15, outcome: 'failed' });
    for (let i = 0; i < 200; i++) metrics.observe('extra')('completed');
    expect(metrics.snapshot()).toMatchObject({ droppedPhases: 73 });
    expect(metrics.snapshot().phases).toHaveLength(128);
    const snapshot = metrics.snapshot();
    snapshot.phases[0].elapsedMs = 999;
    expect(metrics.snapshot().phases[0].elapsedMs).toBe(15);
  });

  it('isolates interleaved requests and does not manufacture background completion in a 202 header', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pending!: ReturnType<typeof currentServerMetrics>;
    const first = withServerMetrics('a', 'prompt', async () => {
      pending = currentServerMetrics();
      const finish = serverPhaseObserver('background-generation');
      void gate.then(() => finish('completed'));
      return new Response(null, { status: 202 });
    });
    const second = await withServerMetrics('b', 'edit', async () => {
      await observePhaseAsync(serverPhaseObserver, 'edit-emitter', async () => undefined);
      return new Response(null);
    });
    const accepted = await first;
    expect(accepted.headers.get('Server-Timing')).not.toContain('background-generation');
    expect(accepted.headers.get('X-Worldstream-Request-Id')).toBe('a');
    expect(second.headers.get('Server-Timing')).toContain('edit-emitter');
    expect(second.headers.get('Server-Timing')).not.toContain('background-generation');
    expect(pending!.snapshot().phases.find(p => p.name === 'background-generation')?.elapsedMs).toBeNull();
    release();
    await gate;
    expect(pending!.snapshot().phases.find(p => p.name === 'background-generation')?.outcome).toBe('completed');
    expect(currentServerMetrics()).toBeUndefined();
  });

  it('preserves refusals and thrown failures without logging private details', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(withServerMetrics('r', 'source', async () => {
      return observePhaseAsync(serverPhaseObserver, 'source-emitter', async () => { throw new Error('secret-prompt'); });
    })).rejects.toThrow('secret-prompt');
    const entry = JSON.parse(log.mock.calls[0][0] as string);
    expect(entry.phases.every((p: { outcome: string }) => p.outcome === 'failed')).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-prompt');
    const refused = await withServerMetrics('refused', 'edit', async () => new Response(null, { status: 429 }));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Server-Timing')).toContain('http-handler');
  });

  it('cannot let a throwing observer or logging sink alter work', async () => {
    const bad = () => { throw new Error('diagnostic failure'); };
    expect(observePhase(bad, 'validation', () => 42)).toBe(42);
    expect(beginPhase(() => bad, 'validation')()).toBeUndefined();
    await expect(observePhaseAsync(bad, 'emitter', async () => 42)).resolves.toBe(42);
    vi.spyOn(console, 'info').mockImplementation(bad);
    expect((await withServerMetrics('r', 'edit', async () => new Response(null))).status).toBe(200);
  });
});
