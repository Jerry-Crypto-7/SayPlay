import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginPhase, observePhase, observePhaseAsync } from '../../model/phase-observer';
import { createServerMetrics, currentServerMetrics, serverPhaseObserver, withServerMetrics } from '../worldstream-metrics';
import { after } from 'next/server';

vi.mock('next/server', () => ({ after: vi.fn((work: Promise<unknown>) => { void work.catch(() => undefined); }) }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(after).mockClear(); });
describe('server phase diagnostics', () => {
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
