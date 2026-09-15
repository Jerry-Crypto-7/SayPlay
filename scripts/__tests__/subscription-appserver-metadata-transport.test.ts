import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), resource: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('../subscription-appserver-fixture-transport', () => ({ createSystemdAppServerMetadataPipeTransport: mocked.resource }));
// Stable authored bytes avoid racing a concurrently edited Python helper. The
// actual measurement uses the real filesystem reader and current source hashes.
vi.mock('node:fs', () => ({ readFileSync: vi.fn((url: URL) => Buffer.from('offline-helper:' + url.pathname)) }));
import { createAppServerMetadataTransport, createSystemdAppServerMetadataTransport, metadataRequests, METADATA_SYSTEM } from '../subscription-appserver-metadata-transport';
import { createAppServerGenerationAdapter, LINUX_SANDBOX_ADVISORY_SUMMARY } from '../subscription-appserver-generation';
import type { GenerationTransportFactory } from '../subscription-appserver-generation';

const hashes = Object.fromEntries(['subscription-appserver-metadata-pipe-child.py', 'subscription-appserver-noenv.py',
  'subscription-worker-lockdown.py', 'subscription-text-model-catalog.json'].map(name =>
  [name, createHash('sha256').update(readFileSync(new URL('../' + name, import.meta.url))).digest('hex')]));
const ready = { version: 1, type: 'ready', utsBoundary: { hostname: 'reality-compiler-probe', namespace: 'uts:[123]' },
  appServerMetadataPipeBoundary: { helperSha256: hashes },
  sandbox: { pidNamespaceInit: true, hostHomeMounted: false, hostMntMounted: false, networkInterfaces: ['lo'], uid: 1000, gid: 1000,
    ttyIsNullDevice: true, runtimeWriteDenied: true, parentNondumpable: true },
  binarySha256: 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
  bwrapSha256: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
  limits: { jobMs: 180000, commandMs: 200000, termGraceMs: 5000, maxOutputBytes: 8388608,
    commandBudgetEnforcedHere: false, aggregateResourcesEnforced: false } };
function setup() {
  const sent: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new Writable({ write(chunk, _encoding, callback) {
    sent.push(JSON.parse(chunk.toString())); callback();
  } }), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() });
  mocked.spawn.mockReturnValue(child);
  let bound: Parameters<GenerationTransportFactory>[0] | undefined;
  const observe = vi.fn(), output = vi.fn((stream: 'stdout' | 'stderr', bytes: Uint8Array) => bound?.onOutput(stream, bytes)),
    accounting = vi.fn((report: { observedBytes: number | null }) => bound?.onOutputAccounting?.(report)), controller = new AbortController();
  const factory = createAppServerMetadataTransport(observe);
  const transport = factory({ onOutput: output, onOutputAccounting: accounting }, controller.signal);
  const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  const begin = () => { frame(ready); frame({ version: 1, type: 'started', mode: 'appserver-metadata-pipe', pid: 2 }); };
  const terminal = (bytes = Buffer.alloc(0), change = {}) => frame({ version: 1, type: 'terminal', reason: 'CANCELLED',
    mode: 'appserver-metadata-pipe', exitCode: -15, elapsedMs: 20, outputBytes: bytes.length,
    observedOutputSha256: createHash('sha256').update(bytes).digest('hex'), outputComplete: true,
    streamEOF: { stdout: true, stderr: true }, outputLimitExceeded: false, registryOverflow: false,
    cleanup: { verified: true, namespaceEmpty: true, observedPidfds: 2, allObservedPidfdsESRCH: true, killSent: false, signalFailures: [] },
    privateChecks: null, credentialFilesRead: false, modelCalls: 0, productionReady: false,
    productionAuth: 'NOT_RUN', productionNetwork: 'NOT_RUN', productionCleanup: 'NOT_RUN', ...change });
  const close = () => child.emit('close', 0, null);
  return { sent, child, observe, output, accounting, controller, factory, transport, frame, begin, terminal, close,
    bindCallbacks(value: Parameters<GenerationTransportFactory>[0]) { bound = value; } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it('uses only the fixed basic launcher and never declares aggregate resources', async () => {
  const f = setup(); f.begin(); f.transport.close(); f.terminal(); f.close();
  expect(await f.transport.cleanup).toEqual({ local: 'confirmed', remote: 'confirmed' });
  expect(mocked.spawn.mock.calls[0]).toEqual(['C:\\Windows\\System32\\wsl.exe', ['--distribution', 'Ubuntu-24.04', '--exec',
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '200s', '/usr/bin/unshare',
    '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--uts', '--pid', '--fork',
    '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]);
  expect(f.sent[0]).toEqual({ type: 'start', mode: 'appserver-metadata-pipe', helperSha256: hashes });
  expect(f.observe.mock.calls[0][0]).toMatchObject({ aggregateResourcesValidated: false, productionReady: false, actualModelCalls: 0 });
});

it.each(['turn/start', 'turn/interrupt', 'account/login/start', 'account/read', 'environment/start', 'unknown'])('rejects %s before any bridge write', async method => {
  const f = setup(); f.begin();
  await expect(f.transport.send({ id: 1, method, params: {} })).rejects.toThrow('METADATA_RPC_NOT_ALLOWED');
  expect(f.sent.some(frame => frame.type === 'fixture_input')).toBe(false);
  f.terminal(); f.close(); expect((await f.transport.cleanup).remote).toBe('confirmed');
  expect(f.observe.mock.calls[0][0].refusedMethod).toBe(method);
});

it.each(['missing', 'wrong', 'extra'])('rejects %s source identity before start', async kind => {
  const f = setup(), helperSha256 = { ...hashes };
  if (kind === 'missing') delete helperSha256['subscription-worker-lockdown.py'];
  if (kind === 'wrong') helperSha256['subscription-appserver-noenv.py'] = '0'.repeat(64);
  if (kind === 'extra') helperSha256['arbitrary.py'] = '0'.repeat(64);
  f.frame({ ...ready, appServerMetadataPipeBoundary: { helperSha256 } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false); expect((await f.transport.cleanup).remote).toBe('unknown');
});

it('admits fixed immutable requests in order, snapshots caller mutation, and ACK waits for actual bridge write', async () => {
  const f = setup(); f.begin(); const requests = metadataRequests();
  for (const request of requests) {
    const operation = f.transport.send(request); request.method = 'account/login/start';
    let settled = false; void operation.then(() => { settled = true; });
    await tick(); expect(settled).toBe(false);
    const sent = f.sent.filter(item => item.type === 'fixture_input').at(-1)!;
    expect(JSON.parse(Buffer.from(sent.data as string, 'base64').toString()).method).not.toBe('account/login/start');
    f.frame({ version: 1, type: 'fixture_input_ack', seq: sent.seq }); await operation;
  }
  await expect(f.transport.send(metadataRequests()[3])).rejects.toThrow('METADATA_RPC_NOT_ALLOWED');
  f.terminal(); f.close(); await f.transport.cleanup;
});

it.each(['initialize-extra', 'initialize-profile', 'order', 'thread-config', 'thread-system', 'thread-environment'])('rejects immutable %s drift', async kind => {
  const f = setup(); f.begin(); const requests = metadataRequests();
  if (kind.startsWith('thread')) {
    for (const request of requests.slice(0, 2)) {
      const operation = f.transport.send(request); await tick();
      f.frame({ version: 1, type: 'fixture_input_ack', seq: f.sent.filter(item => item.type === 'fixture_input').at(-1)!.seq }); await operation;
    }
  }
  const input = structuredClone(kind.startsWith('thread') ? requests[2] : requests[0]);
  if (kind === 'initialize-extra') input.argv = [];
  if (kind === 'initialize-profile') (input.params as Record<string, unknown>).capabilities = { experimentalApi: false };
  if (kind === 'order') input.method = 'thread/start';
  if (kind === 'thread-config') (input.params as Record<string, unknown>).config = {};
  if (kind === 'thread-system') (input.params as Record<string, unknown>).developerInstructions = 'caller instructions';
  if (kind === 'thread-environment') (input.params as Record<string, unknown>).environments = ['host'];
  const before = f.sent.filter(item => item.type === 'fixture_input').length;
  await expect(f.transport.send(input)).rejects.toThrow('METADATA_RPC_NOT_ALLOWED');
  expect(f.sent.filter(item => item.type === 'fixture_input')).toHaveLength(before);
  f.terminal(); f.close(); await f.transport.cleanup;
});

it('forwards bytes before terminal aggregate accounting and cleanup settles', async () => {
  const f = setup(); f.begin(); const bytes = Buffer.from('raw actual metadata\n');
  f.frame({ version: 1, type: 'child_output', stream: 'stdout', encoding: 'base64', data: bytes.toString('base64') });
  f.terminal(bytes); f.close(); expect(f.accounting).not.toHaveBeenCalled();
  expect(await f.transport.cleanup).toEqual({ local: 'confirmed', remote: 'confirmed' });
  expect(f.output).toHaveBeenCalledExactlyOnceWith('stdout', bytes);
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: bytes.length });
  expect(f.output.mock.invocationCallOrder[0]).toBeLessThan(f.accounting.mock.invocationCallOrder[0]);
});

it('counts the received crossing chunk separately from an observed withheld tail without fabricating it', async () => {
  const f = setup(); f.begin(); const bytes = Buffer.alloc(4096, 120), received = 8388608 + 4096, observed = received + 123;
  for (let offset = 0; offset < received; offset += bytes.length) {
    f.frame({ version: 1, type: 'child_output', stream: 'stderr', encoding: 'base64', data: bytes.toString('base64') });
  }
  expect(f.sent.some(frame => frame.type === 'cancel')).toBe(true);
  f.terminal(Buffer.alloc(0), { outputBytes: observed, outputLimitExceeded: true }); f.close();
  expect((await f.transport.cleanup).remote).toBe('confirmed');
  expect(f.output.mock.calls.reduce((sum, call) => sum + call[1].byteLength, 0)).toBe(received);
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: observed });
});

it('cancel during pending write accepts only its matching late ACK and does not mistake ACK for cleanup', async () => {
  const f = setup(); f.begin();
  const operation = f.transport.send(metadataRequests()[0]); const rejected = expect(operation).rejects.toThrow('METADATA_CLOSED');
  await tick(); const input = f.sent.find(frame => frame.type === 'fixture_input')!;
  f.controller.abort(); await rejected;
  f.frame({ version: 1, type: 'fixture_input_ack', seq: input.seq });
  expect(f.observe).not.toHaveBeenCalled(); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it('rejects overlapping factory ownership before a second spawn', async () => {
  const f = setup();
  expect(() => f.factory({ onOutput() {} }, new AbortController().signal)).toThrow('METADATA_TRANSPORT_BUSY');
  expect(mocked.spawn).toHaveBeenCalledTimes(1); f.close(); await f.transport.cleanup;
});

it('a throwing accounting observer cannot create cleanup credit', async () => {
  const f = setup(); f.bindCallbacks({ onOutput() {}, onOutputAccounting() { throw new Error('sink failed'); } });
  f.begin(); f.terminal(); f.close(); expect((await f.transport.cleanup).remote).toBe('unknown');
});

function resourceDouble() {
  let finish!: (value: { local: 'confirmed' | 'unknown'; remote: 'confirmed' | 'unknown' }) => void;
  let reject!: (error: Error) => void;
  const cleanup = new Promise<{ local: 'confirmed' | 'unknown'; remote: 'confirmed' | 'unknown' }>((resolve, rejectCleanup) => { finish = resolve; reject = rejectCleanup; });
  const send = vi.fn(async (_frame: Readonly<Record<string, unknown>>) => undefined), close = vi.fn();
  const rawFactory = vi.fn(() => ({ cleanup, send, close }));
  mocked.resource.mockReturnValue(rawFactory);
  const observe = vi.fn(), factory = createSystemdAppServerMetadataTransport(observe);
  const transport = factory({ onOutput() {} }, new AbortController().signal);
  return { finish, reject, send, close, rawFactory, factory, transport, observe };
}

it('resource variant uses the shared broker and identical literal request gate without spawning its own launcher', async () => {
  const f = resourceDouble();
  for (const frame of metadataRequests().slice(0, 3)) await f.transport.send(frame);
  await expect(f.transport.send({ id: 3, method: 'turn/start', params: {} })).rejects.toThrow('METADATA_RPC_NOT_ALLOWED');
  expect(f.send.mock.calls.map(call => call[0])).toEqual(metadataRequests().slice(0, 3));
  expect(f.close).toHaveBeenCalledTimes(1); expect(mocked.spawn).not.toHaveBeenCalled();
  const raw = { kind: 'ACTUAL_METADATA_PROTOCOL', actualModelCalls: 0, credentialFilesRead: false, productionReady: false,
    aggregateResourcesValidated: true, error: null, ready: { resource: 'ready' }, terminal: { resource: 'cleanup' },
    localClose: { code: 0, signal: null }, outputBytes: 42, systemdOwnership: { unit: 'owned' } };
  mocked.resource.mock.calls[0][0](raw);
  f.finish({ local: 'confirmed', remote: 'confirmed' }); await f.transport.cleanup;
  expect(f.observe).toHaveBeenCalledWith({ ...raw, kind: 'ACTUAL_CLI_METADATA_ONLY',
    admittedMethods: ['initialize', 'initialized', 'thread/start'], refusedMethod: 'turn/start', inputAckScope: 'supervisor-to-bridge-write-only' });
});

it.each(['account/read', 'account/login/start', 'turn/interrupt', 'model/list'])('resource gate rejects %s before shared raw send', async method => {
  const f = resourceDouble();
  await expect(f.transport.send({ id: 1, method, params: {} })).rejects.toThrow('METADATA_RPC_NOT_ALLOWED');
  expect(f.send).not.toHaveBeenCalled(); f.finish({ local: 'confirmed', remote: 'confirmed' }); await f.transport.cleanup;
});

it('resource variant refuses changed developer instructions and snapshots literal metadata', async () => {
  const f = resourceDouble(), requests = metadataRequests();
  await f.transport.send(requests[0]); requests[0].method = 'mutated';
  await f.transport.send(requests[1]);
  (requests[2].params as Record<string, unknown>).developerInstructions = 'caller';
  await expect(f.transport.send(requests[2])).rejects.toThrow('METADATA_RPC_NOT_ALLOWED');
  expect(f.send.mock.calls[0][0].method).toBe('initialize'); expect(f.send).toHaveBeenCalledTimes(2);
  f.finish({ local: 'confirmed', remote: 'confirmed' }); await f.transport.cleanup;
});

it.each(['local', 'remote', 'rejected'])('resource %s unknown cleanup permanently fences a second broker dispatch', async kind => {
  const f = resourceDouble();
  if (kind === 'rejected') f.reject(new Error('cleanup failed'));
  else f.finish({ local: kind === 'local' ? 'unknown' : 'confirmed', remote: kind !== 'local' ? 'unknown' : 'confirmed' });
  await f.transport.cleanup;
  expect(() => f.factory({ onOutput() {} }, new AbortController().signal)).toThrow('PRIOR_TERMINATION_UNKNOWN');
  expect(f.rawFactory).toHaveBeenCalledTimes(1);
});

it.each(['missing-terminal', 'hash-mismatch', 'trailing-utf8', 'wrong-ack', 'wrong-mode'])('fences factory reuse on %s', async kind => {
  const f = setup(); f.begin();
  if (kind === 'hash-mismatch') f.terminal(Buffer.alloc(0), { observedOutputSha256: '0'.repeat(64) });
  if (kind === 'trailing-utf8') { f.terminal(); f.child.stdout.write(Buffer.from([0xc3])); }
  if (kind === 'wrong-ack') f.frame({ version: 1, type: 'fixture_input_ack', seq: 98 });
  if (kind === 'wrong-mode') f.terminal(Buffer.alloc(0), { mode: 'appserver-fixture' });
  f.close(); expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: null });
  expect(() => f.factory({ onOutput() {} }, new AbortController().signal)).toThrow('PRIOR_TERMINATION_UNKNOWN');
  expect(mocked.spawn).toHaveBeenCalledTimes(1);
});

it('generation adapter reaches real-profile metadata then refuses turn without sending it', async () => {
  // Authored response doubles for an offline seam test; this is not actual CLI evidence.
  const g = setup(); const transport = g.transport;
  const adapter = createAppServerGenerationAdapter(callbacks => { g.bindCallbacks(callbacks); return transport; });
  const resultPromise = adapter.generate({ request: { model: 'gpt-5.6-sol', system: METADATA_SYSTEM, user: 'No model turn is allowed.' }, remainingBudgetMs: 1000 });
  g.begin(); const output: Buffer[] = [];
  const emit = (frame: unknown) => { const bytes = Buffer.from(JSON.stringify(frame) + '\n'); output.push(bytes);
    g.frame({ version: 1, type: 'child_output', stream: 'stdout', encoding: 'base64', data: bytes.toString('base64') }); };
  await tick(); const first = g.sent.find(frame => frame.type === 'fixture_input')!;
  g.frame({ version: 1, type: 'fixture_input_ack', seq: first.seq });
  emit({ id: 1, result: { userAgent: 'offline-response-double', platformFamily: 'unix', platformOs: 'linux', codexHome: '/work/appserver-home/fixed-abcdefgh' } });
  emit({ method: 'configWarning', params: { summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null }, emittedAtMs: 1234 });
  await tick(); await tick();
  const second = g.sent.filter(frame => frame.type === 'fixture_input').at(-1)!;
  g.frame({ version: 1, type: 'fixture_input_ack', seq: second.seq }); await tick();
  const third = g.sent.filter(frame => frame.type === 'fixture_input').at(-1)!;
  g.frame({ version: 1, type: 'fixture_input_ack', seq: third.seq });
  emit({ id: 2, result: { thread: { id: 'actual-shape-thread', ephemeral: true, path: null }, model: 'gpt-5.6-sol',
    modelProvider: 'openai', reasoningEffort: 'low', cwd: '/work', approvalPolicy: 'never', runtimeWorkspaceRoots: [],
    sandbox: { type: 'readOnly', networkAccess: false } } });
  await tick(); await tick();
  expect(g.sent.some(frame => frame.type === 'cancel')).toBe(true);
  g.terminal(Buffer.concat(output)); g.close(); const result = await resultPromise;
  expect(result).toMatchObject({ outcome: 'failed', error: 'TRANSPORT_WRITE_FAILED', modelCalls: null, observedTurns: 0,
    cleanup: { local: 'confirmed', remote: 'confirmed' }, productionReady: false });
  expect(g.observe.mock.calls[0][0].refusedMethod).toBe('turn/start');
  expect(result.configurationAdvisories).toEqual([{ kind: 'linux-sandbox-user-namespace-unavailable',
    summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null, emittedAtMs: 1234 }]);
  const requests = g.sent.filter(frame => frame.type === 'fixture_input').map(frame => JSON.parse(Buffer.from(frame.data as string, 'base64').toString()));
  expect(requests.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start']);
});
