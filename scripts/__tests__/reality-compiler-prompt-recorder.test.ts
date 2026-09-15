import { describe, expect, it } from 'vitest';
import { createPreparedPromptRecorder, type PromptSample } from '../reality-compiler-prompt-recorder';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';

function setup(endpoint: 'display' | 'interaction' = 'display') {
  const events: unknown[] = [], writes: Record<string, unknown> = {}, late: unknown[] = [];
  const sink: ReviewArtifactSink = { append: event => { events.push(event); }, late: event => { late.push(event); },
    write(name, value) { expect(writes[name]).toBeUndefined(); writes[name] = value; return { path: name, sha256: 'a'.repeat(64) }; },
    seal: () => ({ path: 'journal.jsonl', sha256: 'a'.repeat(64) }) };
  const recorder = createPreparedPromptRecorder({ prompt: 'A tower.', endpoint, sink, build: {}, now: () => 0 });
  const accept = (match = 'exact') => {
    expect(recorder.allow('POST', '/api/worldstream/sessions', { prompt: 'A tower.' })).toBe(true);
    recorder.accepted(202, JSON.stringify({ sessionId: 'abc', authored: { match }, events: '/api/worldstream/sessions/abc/events',
      snapshot: '/api/worldstream/sessions/abc' }), {});
  };
  return { recorder, accept, events, writes, late };
}
function sample(interaction = false): PromptSample {
  return { pipeline: { version: 'worldstream-pipeline-v1', currentRunId: 1, runs: [{ runId: 1, generation: 1,
    kind: 'prompt', provenance: 'prepared', outcome: 'pending', startedAtMs: 0, endedAtMs: null, elapsedMs: null, droppedStages: 0,
    stages: [{ stageId: 1, name: 'first-frame', provenance: 'prepared', outcome: 'completed', startedAtMs: 0, endedAtMs: 10, elapsedMs: 10 },
      { stageId: 2, name: 'first-interaction', provenance: 'prepared', outcome: interaction ? 'completed' : 'pending',
        startedAtMs: 10, endedAtMs: interaction ? 20 : null, elapsedMs: interaction ? 10 : null }] }] },
    renderer: { ready: true, frames: 2, drawCalls: 1, triangles: 20 },
    authoredNotice: 'This world was authored ahead of time.', runtime: { tick: 1, inputs: interaction ? 1 : 0 },
    runtimeEvidence: { inputResult: interaction ? 'Input at tick 1. Applied: win' : null,
      ruleTrace: interaction ? 'Tick 1: moveTo target -> win' : null, tick: '1' } };
}
describe('prepared prompt recorder', () => {
  it('completes display while interaction remains pending without live or human credit', () => {
    const { recorder, accept } = setup(); accept(); recorder.observe(sample());
    expect(recorder.finish()).toMatchObject({ outcome: 'completed', endpoint: 'display', origin: 'prepared', match: 'exact',
      modelCalls: 0, protocolAttempt: null, humanObservation: false, liveMeasurement: 'NOT_RUN' });
  });
  it('requires completed first interaction when selected', () => {
    const { recorder, accept } = setup('interaction'); accept(); recorder.observe(sample()); expect(recorder.terminal).toBe(false);
    recorder.observe(sample(true)); expect(recorder.finish().outcome).toBe('completed');
  });
  it('does not treat missing GPU draw or missing provenance notice as display', () => {
    const { recorder, accept } = setup(); accept();
    const value = sample(); value.renderer!.triangles = 0; recorder.observe(value); expect(recorder.terminal).toBe(false);
    value.renderer!.triangles = 20; value.authoredNotice = null; recorder.observe(value); expect(recorder.terminal).toBe(false);
    expect(recorder.finish().outcome).toBe('interrupted');
  });
  it('requires the nearest-scene limitation and keeps its provenance', () => {
    const { recorder, accept } = setup(); accept('nearest'); recorder.observe(sample()); expect(recorder.terminal).toBe(false);
    const value = sample(); value.authoredNotice = 'This is the closest world authored ahead of time. Relevance has not been verified.';
    recorder.observe(value); expect(recorder.finish()).toMatchObject({ outcome: 'completed', match: 'nearest' });
  });
  it.each([{ prompt: 'changed' }, { prompt: 'A tower.', extra: true }, null])('blocks changed or malformed request %j', body => {
    const { recorder } = setup(); expect(recorder.allow('POST', '/api/worldstream/sessions', body)).toBe(false);
    expect(recorder.finish().error).toBe('UNMEASURED_REQUEST_BLOCKED');
  });
  it('blocks automatic live generation without failing prepared display', () => {
    const { recorder, accept } = setup(); accept();
    expect(recorder.allow('POST', '/api/worldstream/sessions', { prompt: 'A tower.', live: true })).toBe(false);
    recorder.observe(sample()); expect(recorder.finish().outcome).toBe('completed');
  });
  it('only permits reads belonging to its accepted session', () => {
    const { recorder, accept } = setup(); accept();
    expect(recorder.allow('GET', '/api/worldstream/sessions/abc/events', null)).toBe(true);
    expect(recorder.allow('GET', '/api/worldstream/sessions/abc', null)).toBe(true);
    expect(recorder.allow('GET', '/api/worldstream/sessions/other', null)).toBe(false);
  });
  it('rejects live or redirected session response', () => {
    const { recorder } = setup(); recorder.allow('POST', '/api/worldstream/sessions', { prompt: 'A tower.' });
    recorder.accepted(202, JSON.stringify({ sessionId: 'abc', events: 'https://other.test' }), {});
    expect(recorder.finish().error).toBe('PREPARED_SESSION_REQUIRED');
  });
  it('rejects duplicate submission and journal truncation', () => {
    const first = setup(); first.accept(); expect(first.recorder.allow('POST', '/api/worldstream/sessions', { prompt: 'A tower.' })).toBe(false);
    const second = setup(); second.accept(); const value = sample();
    value.pipeline = { ...value.pipeline!, runs: [{ ...value.pipeline!.runs[0], droppedStages: 1 }] };
    second.recorder.observe(value); expect(second.recorder.finish().error).toBe('UNEXPECTED_PIPELINE_HISTORY');
  });
  it('preserves cancellation, does not revive on late samples, seals once', () => {
    const { recorder, accept, late } = setup(); accept(); recorder.fail('ABORT', 'cancelled'); recorder.observe(sample());
    expect(recorder.finish().outcome).toBe('cancelled'); recorder.http({ late: true }); expect(late).toHaveLength(1);
    expect(() => recorder.finish()).toThrow('ALREADY_FINISHED');
  });
  it('bounds polling and records identical snapshots only once', () => {
    const { recorder, accept, events } = setup('interaction'); accept();
    for (let i = 0; i < 1201; i++) recorder.observe(sample());
    expect(recorder.finish().error).toBe('SAMPLE_LIMIT');
    expect(events.filter(event => (event as { event: string }).event === 'browser-sample')).toHaveLength(1);
  });
});
