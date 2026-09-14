import { afterEach, expect, it, vi } from 'vitest';
import { createAppServerGenerationAdapter, type GenerationCleanup, type GenerationTransportFactory, APP_SERVER_GENERATION_LIMITS, LINUX_SANDBOX_ADVISORY_SUMMARY } from '../subscription-appserver-generation';

const request = { model: 'gpt-5.6-sol', system: 'Return a JSON object.', user: 'Build a room.' };
const initialized = { userAgent: 'codex/0.145.0', platformFamily: 'unix', platformOs: 'linux', codexHome: '/work/appserver-home/fixed-abcdefgh' };
const thread = { id: 'thread-1', ephemeral: true, path: null };
const profile = { thread, model: 'gpt-5.6-sol', modelProvider: 'openai', reasoningEffort: 'low', cwd: '/work', approvalPolicy: 'never',
  runtimeWorkspaceRoots: [], sandbox: { type: 'readOnly', networkAccess: false } };
const remoteDisabled = { method: 'remoteControl/status/changed', emittedAtMs: 1234,
  params: { status: 'disabled', serverName: 'fixture', installationId: 'a464dc32-582b-48ae-a6b8-2b1978c1ddae', environmentId: null } };
const configWarning = { method: 'configWarning', emittedAtMs: 1234, params: { summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null } };
function fixture(autoCleanup = true) {
  const sent: Record<string, unknown>[] = [];
  let received = 0;
  let output!: Parameters<GenerationTransportFactory>[0]['onOutput'];
  let accounting!: NonNullable<Parameters<GenerationTransportFactory>[0]['onOutputAccounting']>;
  let finish!: (value: GenerationCleanup) => void;
  const cleanup = new Promise<GenerationCleanup>(resolve => { finish = resolve; });
  const close = vi.fn(() => { if (autoCleanup) finish({ local: 'confirmed', remote: 'confirmed' }); });
  const factory = vi.fn<GenerationTransportFactory>((callbacks) => {
    output = callbacks.onOutput;
    accounting = callbacks.onOutputAccounting!;
    return { send: async frame => { sent.push(structuredClone(frame)); }, close, cleanup };
  });
  const adapter = createAppServerGenerationAdapter(factory);
  const raw = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => { received += Buffer.byteLength(text); output(stream, Buffer.from(text)); };
  const rawBytes = (bytes: Uint8Array) => { received += bytes.byteLength; output('stdout', bytes); };
  const report = (observedBytes: number | null) => accounting({ observedBytes });
  const frame = async (value: unknown) => { raw(JSON.stringify(value) + '\n'); await flush(); };
  const start = () => adapter.generate({ request, remainingBudgetMs: 180000 });
  return { adapter, start, factory, sent, close, finish, raw, rawBytes, frame, report,
    received: () => received,
    accounting: (value: unknown) => accounting(value as { observedBytes: number | null }) };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function handshake(f: ReturnType<typeof fixture>) {
  await flush(); await f.frame({ id: 1, result: initialized }); await f.frame({ id: 2, result: profile });
}
const turn = { id: 'turn-1', status: 'inProgress', items: [], error: null };
async function begin(f: ReturnType<typeof fixture>) {
  await handshake(f); await f.frame({ method: 'turn/started', params: { threadId: thread.id, turn } });
  await f.frame({ id: 3, result: { turn } });
}
async function answer(f: ReturnType<typeof fixture>, text = '{"ok":true}') {
  const params = { threadId: thread.id, turnId: turn.id };
  await f.frame({ method: 'item/started', params: { ...params, item: { type: 'agentMessage', id: 'item-1', text: '', phase: null } } });
  await f.frame({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'item-1', delta: text } });
  await f.frame({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', id: 'item-1', text, phase: 'final_answer' } } });
  await f.frame({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  { ...request, model: 'other' }, { ...request, user: '' }, { ...request, argv: ['login'] }, { ...request, config: {} },
])('rejects invalid request before factory dispatch %j', async invalid => {
  const f = fixture();
  const result = await f.adapter.generate({ request: invalid, remainingBudgetMs: 180000 });
  expect(result.error).toBe('INVALID_GENERATION_REQUEST'); expect(f.factory).not.toHaveBeenCalled();
});

it.each(['model', 'modelProvider', 'reasoningEffort', 'cwd', 'approvalPolicy'])('rejects wrong thread %s before turn', async field => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame({ id: 2, result: { ...profile, [field]: 'wrong' } });
  expect(await pending).toMatchObject({ error: 'THREAD_PROFILE_MISMATCH', modelCalls: 0 });
  expect(f.sent.some(value => value.method === 'turn/start')).toBe(false);
});

it.each([
  { id: 2, result: profile }, { id: 1, error: { code: -1, message: 'fail' } },
  { id: 7, method: 'account/login/start', params: {} }, { method: 'environment/added', params: {} },
])('rejects unexpected protocol envelope %j', async frame => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame(frame);
  expect((await pending).outcome).toBe('failed'); expect(f.sent).toHaveLength(1);
});

it('rejects duplicate keys and counts original rejected bytes', async () => {
  const f = fixture(), pending = f.start(); await flush(); const text = '{"id":1,"id":1,"result":{}}\n'; f.raw(text);
  expect(await pending).toMatchObject({ error: 'DUPLICATE_JSON_KEY', outputBytes: Buffer.byteLength(text) });
});

it('counts oversized output but never retains its full body', async () => {
  const f = fixture(), pending = f.start(); await flush(); f.raw('x'.repeat(APP_SERVER_GENERATION_LIMITS.outputBytes + 1), 'stderr');
  expect(await pending).toMatchObject({ error: 'OUTPUT_LIMIT', outputBytes: APP_SERVER_GENERATION_LIMITS.outputBytes + 1, stderrRaw: '' });
});

it('uses remaining overall deadline and blocks after unknown cleanup', async () => {
  vi.useFakeTimers(); const f = fixture(false);
  const pending = f.adapter.generate({ request, remainingBudgetMs: 20 }); await flush();
  await vi.advanceTimersByTimeAsync(5020);
  expect(await pending).toMatchObject({ error: 'GENERATION_DEADLINE', cleanup: { local: 'unknown', remote: 'unknown' } });
  expect((await f.start()).error).toBe('PRIOR_TERMINATION_UNKNOWN'); expect(f.factory).toHaveBeenCalledTimes(1);
});

it('keeps late bytes separate and does not unfreeze an unknown cleanup', async () => {
  vi.useFakeTimers(); const f = fixture(false), late = vi.fn();
  const pending = f.adapter.generate({ request, remainingBudgetMs: 1 }, undefined, undefined, late);
  await vi.advanceTimersByTimeAsync(5001); const result = await pending;
  f.raw('late'); f.finish({ local: 'confirmed', remote: 'confirmed' }); await flush();
  expect(result.outputBytes).toBe(0); expect(late).toHaveBeenCalledWith(expect.objectContaining({ kind: 'output', bytes: 4 }));
  expect((await f.start()).error).toBe('PRIOR_TERMINATION_UNKNOWN');
});

it('prevents concurrent dispatch', async () => {
  const f = fixture(), pending = f.start(); await flush();
  expect((await f.start()).error).toBe('GENERATION_IN_PROGRESS');
  await f.frame({ method: 'unknown', params: {} }); await pending; expect(f.factory).toHaveBeenCalledTimes(1);
});

it('normalizes only completed final JSON after independent cleanup and sends the fixed profile', async () => {
  const f = fixture(), provider = vi.fn();
  const pending = f.adapter.generate({ request, remainingBudgetMs: 180000 }, undefined, provider);
  await begin(f); await answer(f);
  expect(await pending).toMatchObject({ outcome: 'completed', json: { ok: true }, jsonText: '{"ok":true}', modelCalls: null, observedTurns: 1,
    cleanup: { local: 'confirmed', remote: 'confirmed' }, productionReady: false });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.sent.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  expect(f.sent[2].params).toMatchObject({ environments: [], ephemeral: true, developerInstructions: request.system,
    config: { model_reasoning_effort: 'low', model_catalog_json: '/usr/bin/text-model-catalog.json', 'agents.enabled': false,
      'features.shell_tool': false, 'features.apps': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
      'features.image_generation': false, 'features.goals': false, 'features.memories': false, 'features.plugins': false,
      'features.code_mode': false, 'features.code_mode_only': false, 'features.deferred_executor': false, 'features.token_budget': false,
      'features.current_time_reminder': false, 'features.skill_search': false, 'tools.experimental_request_user_input.enabled': false,
      'orchestrator.skills.enabled': false, 'orchestrator.mcp.enabled': false, 'skills.include_instructions': false, web_search: 'disabled' } });
  expect(f.sent[3].params).toEqual({ threadId: thread.id, input: [{ type: 'text', text: request.user }], environments: [],
    model: 'gpt-5.6-sol', effort: 'low', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [] });
});

it.each(['[]', '{}', 'not json', '{"a":1,"a":2}'])('rejects invalid normalized result %s', async text => {
  const f = fixture(), pending = f.start(); await begin(f); await answer(f, text); expect((await pending).outcome).toBe('failed');
});

it.each([
  { method: 'turn/started', params: { threadId: 'other', turn } },
  { method: 'item/started', params: { threadId: thread.id, turnId: 'other', item: {} } },
  { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'commandExecution', id: 'x' } } },
  { method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'missing', delta: '{}' } },
  { method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } },
])('rejects forged event or unrequested tool %j', async event => {
  const f = fixture(), pending = f.start(); await begin(f); await f.frame(event); expect((await pending).outcome).toBe('failed');
});

it('cancels only its own bound turn and never mistakes interrupt ack for cleanup', async () => {
  vi.useFakeTimers(); const f = fixture(false), control = new AbortController();
  const pending = f.adapter.generate({ request, remainingBudgetMs: 180000 }, control.signal);
  await begin(f); control.abort(); await flush(); await f.frame({ id: 4, result: {} });
  expect(f.sent.at(-1)).toEqual({ id: 4, method: 'turn/interrupt', params: { threadId: thread.id, turnId: turn.id } });
  await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ error: 'GENERATION_CANCELLED', cleanup: { remote: 'unknown' } });
});

it('records unknown model accounting after turn dispatch without observed started', async () => {
  const f = fixture(), pending = f.start(); await handshake(f); await f.frame({ id: 3, error: { code: -1 } });
  expect(await pending).toMatchObject({ outcome: 'failed', modelCalls: null });
});

it('rejects a turn reply which contradicts an earlier started identity', async () => {
  const f = fixture(), pending = f.start(); await handshake(f);
  await f.frame({ method: 'turn/started', params: { threadId: thread.id, turn } });
  await f.frame({ id: 3, result: { turn: { ...turn, id: 'other' } } });
  expect(await pending).toMatchObject({ error: 'TURN_IDENTITY_MISMATCH' });
});

it('rejects a response before its outbound request was fully delivered', async () => {
  const f = fixture(), pending = f.start(); f.raw(JSON.stringify({ id: 1, result: initialized }) + '\n');
  expect((await pending).outcome).toBe('failed'); expect(f.sent).toHaveLength(0);
});

it('freezes text before awaiting any transport work', async () => {
  const f = fixture(), mutable = { ...request };
  const pending = f.adapter.generate({ request: mutable, remainingBudgetMs: 180000 }); mutable.user = 'changed'; mutable.system = 'changed';
  await begin(f); await answer(f); await pending;
  expect(f.sent[2].params).toMatchObject({ developerInstructions: request.system });
  expect(f.sent[3].params).toMatchObject({ input: [{ type: 'text', text: request.user }] });
});

it('handles split multibyte UTF8 using actual bytes', async () => {
  const text = JSON.stringify({ id: 1, result: { ...initialized, userAgent: 'žluťoučký' } }) + '\n';
  // Split inside ž, not at a JavaScript code-unit boundary.
  const block = Buffer.from(text), index = block.indexOf(Buffer.from('ž')) + 1;
  const chunks = [block.subarray(0, index), block.subarray(index)];
  // Dedicated factory retains split bytes without decoding them first.
  let output!: Parameters<GenerationTransportFactory>[0]['onOutput']; let finish!: (value: GenerationCleanup) => void;
  const adapter = createAppServerGenerationAdapter(callbacks => {
    output = callbacks.onOutput;
    return { send: async () => {}, cleanup: new Promise(resolve => { finish = resolve; }), close: () => finish({ local: 'confirmed', remote: 'confirmed' }) };
  });
  const result = adapter.generate({ request, remainingBudgetMs: 180000 }); await flush();
  chunks.forEach(chunk => output('stdout', chunk)); await flush();
  output('stdout', Buffer.from(JSON.stringify({ id: 2, result: { ...profile, model: 'wrong' } }) + '\n'));
  expect(await result).toMatchObject({ error: 'THREAD_PROFILE_MISMATCH' });
});

it('does not grant success for a valid turn when remote cleanup is unknown', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f);
  f.finish({ local: 'confirmed', remote: 'unknown' });
  expect(await pending).toMatchObject({ error: 'TERMINATION_UNKNOWN', json: null });
  expect((await f.start()).error).toBe('PRIOR_TERMINATION_UNKNOWN');
});

it('accounts bytes after an error before sealing, and rejects trailing terminal stdout', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f);
  f.raw('unexpected\n'); f.finish({ local: 'confirmed', remote: 'confirmed' });
  const result = await pending;
  expect(result.error).toBe('OUTPUT_AFTER_TERMINAL'); expect(result.wireRaw).toContain('unexpected');
});

it('requires delta and completed text to agree', async () => {
  const f = fixture(), pending = f.start(); await begin(f);
  const params = { threadId: thread.id, turnId: turn.id };
  await f.frame({ method: 'item/started', params: { ...params, item: { id: 'x', type: 'agentMessage', phase: null, text: '' } } });
  await f.frame({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'x', delta: '{"x":1}' } });
  await f.frame({ method: 'item/completed', params: { ...params, item: { id: 'x', type: 'agentMessage', phase: 'final_answer', text: '{"x":2}' } } });
  expect((await pending).error).toBe('ITEM_COMPLETION_MISMATCH');
});

it('rejects incomplete UTF8 after a complete terminal JSONL in the same raw chunk', async () => {
  const f = fixture(), pending = f.start(); await begin(f);
  const params = { threadId: thread.id, turnId: turn.id }, text = '{"ok":true}';
  await f.frame({ method: 'item/started', params: { ...params, item: { id: 'x', type: 'agentMessage', phase: null, text: '' } } });
  await f.frame({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'x', delta: text } });
  await f.frame({ method: 'item/completed', params: { ...params, item: { id: 'x', type: 'agentMessage', phase: 'final_answer', text } } });
  const terminal = JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } }) + '\n';
  f.rawBytes(Buffer.concat([Buffer.from(terminal), Buffer.from([0xc3])]));
  expect(await pending).toMatchObject({ error: 'TRUNCATED_UTF8', json: null });
});

it('rejects terminal input after monotonic deadline even before the timer callback runs', async () => {
  vi.useFakeTimers(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture(), pending = f.start(); await begin(f);
  now = 180001;
  await f.frame({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
  expect(await pending).toMatchObject({ error: 'GENERATION_DEADLINE', json: null });
});

it('accepts exactly bounded disabled remote metadata after initialize without emitting an RPC', async () => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame(remoteDisabled); await f.frame({ id: 2, result: profile });
  await f.frame({ method: 'turn/started', params: { threadId: thread.id, turn }, emittedAtMs: 1235 });
  await f.frame({ id: 3, result: { turn } }); await answer(f);
  expect(await pending).toMatchObject({ outcome: 'completed', productionReady: false, modelCalls: null });
  expect(f.sent.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
});

it.each([
  { status: 'connected' }, { status: 'connecting' }, { status: 'errored' }, { status: 'unknown' },
  { environmentId: 'some-environment' }, { serverName: '' }, { serverName: 'x'.repeat(257) },
  { serverName: 'name\n' }, { installationId: 'not-a-uuid' }, { extra: true },
])('rejects changed remote metadata %j', async patch => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame({ ...remoteDisabled, params: { ...remoteDisabled.params, ...patch } });
  expect((await pending).error).toBe('REMOTE_CONTROL_STATUS_REJECTED');
  expect(f.sent.some(frame => String(frame.method).startsWith('remoteControl/'))).toBe(false);
});

it.each([-1, 1.5, null, '1234', Number.MAX_SAFE_INTEGER + 1])('rejects malformed notification timestamp %j', async emittedAtMs => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame({ ...remoteDisabled, emittedAtMs }); expect((await pending).error).toBe('INVALID_NOTIFICATION');
});

it.each([
  { ...remoteDisabled, extra: true },
  { ...remoteDisabled, method: 'remoteControl/unknown' },
  { ...remoteDisabled, id: 7 },
])('rejects unknown metadata envelope %j', async frame => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame(frame); expect((await pending).outcome).toBe('failed');
});

it('rejects remote metadata before initialize reply and duplicates after it', async () => {
  const early = fixture(), first = early.start(); await flush(); await early.frame(remoteDisabled);
  expect((await first).error).toBe('REMOTE_CONTROL_STATUS_REJECTED');
  const duplicate = fixture(), second = duplicate.start(); await flush(); await duplicate.frame({ id: 1, result: initialized });
  await duplicate.frame(remoteDisabled); await duplicate.frame(remoteDisabled);
  expect((await second).error).toBe('REMOTE_CONTROL_STATUS_REJECTED');
});

it.each([true, false])('preserves the single known post-initialize advisory and its original raw bytes (timestamp %s)', async timestamp => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  const warning = timestamp ? configWarning : { method: configWarning.method, params: configWarning.params };
  await f.frame(warning); await f.frame({ id: 2, result: profile });
  await f.frame({ method: 'turn/started', params: { threadId: thread.id, turn } }); await f.frame({ id: 3, result: { turn } });
  await answer(f); const result = await pending;
  expect(result.configurationAdvisories).toEqual([{ kind: 'linux-sandbox-user-namespace-unavailable',
    summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null, ...(timestamp ? { emittedAtMs: 1234 } : {}) }]);
  expect(result.wireRaw).toContain(JSON.stringify(warning) + '\n'); expect(result.outputBytes).toBe(f.received());
  expect(result).toMatchObject({ outcome: 'completed', productionReady: false });
  expect(f.sent.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  expect(Object.isFrozen(result.configurationAdvisories)).toBe(true); expect(Object.isFrozen(result.configurationAdvisories[0])).toBe(true);
  const snapshot = JSON.stringify(result.configurationAdvisories); f.raw(JSON.stringify(configWarning) + '\n');
  expect(JSON.stringify(result.configurationAdvisories)).toBe(snapshot);
});

it.each([
  { summary: 'another warning' }, { details: '' }, { details: 'diagnostic' }, { path: null }, { range: null }, { extra: true },
])('rejects unknown or expanded advisory payload %j', async patch => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame({ ...configWarning, params: { ...configWarning.params, ...patch } });
  expect(await pending).toMatchObject({ error: 'CONFIGURATION_ADVISORY_REJECTED', configurationAdvisories: [], modelCalls: 0 });
});

it('rejects advisory before validated initialize and repeated advisory, preserving first accepted evidence', async () => {
  const early = fixture(), first = early.start(); await flush(); await early.frame(configWarning);
  expect(await first).toMatchObject({ error: 'CONFIGURATION_ADVISORY_REJECTED', configurationAdvisories: [] });
  const duplicate = fixture(), second = duplicate.start(); await flush(); await duplicate.frame({ id: 1, result: initialized });
  await duplicate.frame(configWarning); await duplicate.frame(configWarning);
  const result = await second; expect(result.error).toBe('CONFIGURATION_ADVISORY_REJECTED'); expect(result.configurationAdvisories).toHaveLength(1);
  expect(duplicate.sent.some(frame => frame.method === 'turn/start')).toBe(false);
});

it.each([-1, null, true, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])('rejects malformed advisory timestamp %j', async emittedAtMs => {
  const f = fixture(), pending = f.start(); await flush(); await f.frame({ id: 1, result: initialized });
  await f.frame({ ...configWarning, emittedAtMs });
  expect(await pending).toMatchObject({ error: 'INVALID_NOTIFICATION', configurationAdvisories: [] });
});

it('late advisory is only late raw evidence and cannot mutate a sealed result', async () => {
  const f = fixture(), late = vi.fn();
  const pending = f.adapter.generate({ request, remainingBudgetMs: 180000 }, undefined, undefined, late);
  await begin(f); await answer(f); const result = await pending;
  f.raw(JSON.stringify(configWarning) + '\n');
  expect(result.configurationAdvisories).toEqual([]);
  expect(late).toHaveBeenCalledWith(expect.objectContaining({ kind: 'output', bytes: Buffer.byteLength(JSON.stringify(configWarning) + '\n') }));
});

it.each(['features.multi_agent', 'features.multi_agent_v2'])('never accepts caller configuration enabling %s', async feature => {
  const f = fixture();
  const result = await f.adapter.generate({ request: { ...request, config: { [feature]: true } } as typeof request, remainingBudgetMs: 180000 });
  expect(result.error).toBe('INVALID_GENERATION_REQUEST'); expect(f.factory).not.toHaveBeenCalled();
});

it('preserves backward-compatible delivered output while leaving unreported aggregate totals unknown', async () => {
  const f = fixture(), pending = f.start(); await begin(f); await answer(f);
  const result = await pending;
  expect(result.outcome).toBe('completed');
  expect(result.outputAccounting).toEqual({ receivedBytes: result.outputBytes,
    receivedByStream: { stdout: result.outputBytes, stderr: 0 }, observedBytes: null, withheldBytes: null, status: 'unreported' });
});

it('accounts aggregate withheld bytes before sealing without inventing a body or stream totals', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f);
  f.raw('diagnostic', 'stderr');
  f.report(APP_SERVER_GENERATION_LIMITS.outputBytes + 99);
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  const result = await pending;
  expect(result.error).toBe('OUTPUT_LIMIT');
  expect(result.outputAccounting).toEqual({ receivedBytes: result.outputBytes,
    receivedByStream: { stdout: Buffer.byteLength(result.wireRaw), stderr: 10 },
    observedBytes: APP_SERVER_GENERATION_LIMITS.outputBytes + 99,
    withheldBytes: APP_SERVER_GENERATION_LIMITS.outputBytes + 99 - result.outputBytes, status: 'reported' });
  expect(result.stderrRaw).toBe('diagnostic'); expect(result.wireRaw.length).toBeLessThan(10000);
});

it.each([NaN, Infinity, -1, 1.5, true, Number.MAX_SAFE_INTEGER + 1])('rejects invalid aggregate count %s without inventing zero', async count => {
  const f = fixture(), pending = f.start(); await flush(); f.accounting({ observedBytes: count });
  expect(await pending).toMatchObject({ outcome: 'failed', error: 'OUTPUT_ACCOUNTING_INVALID',
    outputAccounting: { observedBytes: null, withheldBytes: null, status: 'invalid' } });
});

it.each([{}, null, { observedBytes: 0, stdout: 0 }, { observedBytes: '0' }])('rejects malformed count-only receipt %j', async receipt => {
  const f = fixture(), pending = f.start(); await flush(); f.accounting(receipt);
  expect(await pending).toMatchObject({ error: 'OUTPUT_ACCOUNTING_INVALID', outputAccounting: { status: 'invalid', observedBytes: null } });
});

it('rejects totals below bytes already received, including stderr', async () => {
  const f = fixture(), pending = f.start(); await flush(); f.raw('12345', 'stderr'); f.report(4);
  expect(await pending).toMatchObject({ error: 'OUTPUT_ACCOUNTING_INVALID', outputBytes: 5,
    outputAccounting: { receivedByStream: { stdout: 0, stderr: 5 }, observedBytes: null, status: 'invalid' } });
});

it('rejects a decreasing aggregate watermark and keeps invalid accounting sticky', async () => {
  const f = fixture(false), pending = f.start(); await flush(); f.report(10); f.report(9); f.report(20);
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  expect(await pending).toMatchObject({ error: 'OUTPUT_ACCOUNTING_INVALID', outputAccounting: { observedBytes: null, status: 'invalid' } });
});

it('accepts equal watermarks and permits a newer total after additional delivered bytes', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f);
  f.report(f.received()); f.report(f.received()); f.raw('tail', 'stderr'); f.report(f.received());
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  const result = await pending;
  expect(result.outcome).toBe('completed'); expect(result.outputAccounting).toMatchObject({ observedBytes: f.received(), status: 'reported' });
  expect(result.outputAccounting.withheldBytes).toBe(0);
});

it('unseen bytes below the cap cannot hide an unparsed protocol tail and still produce success', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f); f.report(f.received() + 1);
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  expect(await pending).toMatchObject({ error: 'OUTPUT_WITHHELD', outputAccounting: { withheldBytes: 1, status: 'reported' } });
});

it('replaces a known total with explicit unknown without stale numeric credit', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f); f.report(10000); f.report(null);
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  expect(await pending).toMatchObject({ error: 'OUTPUT_ACCOUNTING_UNKNOWN', outputAccounting: { observedBytes: null, withheldBytes: null, status: 'unknown' } });
});

it('a numeric receipt after unknown can update accounting but cannot restore success', async () => {
  const f = fixture(false), pending = f.start(); await begin(f); await answer(f); f.report(null); f.report(10000);
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  expect(await pending).toMatchObject({ error: 'OUTPUT_ACCOUNTING_UNKNOWN', outputAccounting: { observedBytes: 10000, status: 'reported' } });
});

it('rejects an opted-in stale final watermark when subsequent raw bytes exceed it', async () => {
  const f = fixture(false), pending = f.start(); await flush(); f.report(0); await begin(f); await answer(f);
  f.finish({ local: 'confirmed', remote: 'confirmed' });
  expect(await pending).toMatchObject({ error: 'OUTPUT_ACCOUNTING_INCOMPLETE', outputAccounting: { observedBytes: null, withheldBytes: null, status: 'invalid' } });
});

it('accounts crossing raw bytes in both streams without reducing the retention cap', async () => {
  const f = fixture(false), pending = f.start(); await flush();
  const prefix = 'x'.repeat(APP_SERVER_GENERATION_LIMITS.outputBytes - 2);
  f.raw(prefix, 'stderr'); f.rawBytes(Buffer.from([1, 2, 3, 4])); f.raw('drain', 'stderr');
  f.report(APP_SERVER_GENERATION_LIMITS.outputBytes + 100); f.finish({ local: 'confirmed', remote: 'confirmed' });
  const result = await pending;
  expect(result.error).toBe('OUTPUT_LIMIT'); expect(Buffer.byteLength(result.stderrRaw)).toBe(prefix.length); expect(result.wireRaw).toBe('');
  expect(result.outputAccounting).toMatchObject({ receivedBytes: APP_SERVER_GENERATION_LIMITS.outputBytes + 7,
    receivedByStream: { stdout: 4, stderr: APP_SERVER_GENERATION_LIMITS.outputBytes + 3 },
    observedBytes: APP_SERVER_GENERATION_LIMITS.outputBytes + 100, withheldBytes: 93, status: 'reported' });
});

it('keeps the primary failure while rejecting malformed later accounting', async () => {
  const f = fixture(false), pending = f.start(); await flush(); f.raw('not-json\n'); f.accounting({ observedBytes: -1 }); f.report(100);
  f.finish({ local: 'confirmed', remote: 'confirmed' }); const result = await pending;
  expect(result.error).not.toBe('OUTPUT_ACCOUNTING_INVALID');
  expect(result.outputAccounting).toMatchObject({ observedBytes: null, withheldBytes: null, status: 'invalid' });
});

it('reports late cumulative totals and invalid counts separately without mutating sealed nested results', async () => {
  const f = fixture(), late = vi.fn();
  const pending = f.adapter.generate({ request, remainingBudgetMs: 180000 }, undefined, undefined, late);
  await begin(f); await answer(f); const result = await pending, sealed = structuredClone(result);
  f.raw('late', 'stderr'); f.report(result.outputBytes + 14);
  expect(late).toHaveBeenCalledWith({ kind: 'output-accounting', accounting: {
    receivedBytes: result.outputBytes + 4, receivedByStream: { stdout: result.outputBytes, stderr: 4 },
    observedBytes: result.outputBytes + 14, withheldBytes: 10, status: 'reported' }, error: null });
  f.report(result.outputBytes + 13); f.report(result.outputBytes + 20);
  expect(late).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'output-accounting', error: 'OUTPUT_ACCOUNTING_INVALID',
    accounting: expect.objectContaining({ observedBytes: null, withheldBytes: null, status: 'invalid' }) }));
  expect(result).toEqual(sealed);
});
