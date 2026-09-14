import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { runCliSupervisorProbe } from '../subscription-cli-probe-transport';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const workerBoundary = {
  helperSha256: { 'subscription-worker-lockdown.py': 'a'.repeat(64), 'subscription-worker-boundary-child.py': 'b'.repeat(64) },
  namespace: 'pid:[100]', mountNamespace: 'mnt:[200]',
  output: { dev: 1, ino: 2, type: 4096 }, control: { dev: 1, ino: 3, type: 4096 },
};
const metadataPipeHashes = { 'subscription-appserver-metadata-pipe-child.py': 'a'.repeat(64),
  'subscription-appserver-noenv.py': 'b'.repeat(64), 'subscription-worker-lockdown.py': 'c'.repeat(64),
  'subscription-text-model-catalog.json': 'd'.repeat(64) };
const execWorkerHashes = Object.fromEntries(['subscription-exec-server-worker-gate.py',
  'subscription-exec-server-worker-trampoline.py', 'subscription-exec-worker-probe.py',
  'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json']
  .map(name => [name, 'a'.repeat(64)]));
const trustedControlHashes: Record<string, string> = { ...execWorkerHashes,
  'subscription-trusted-control-boundary-parent.py': 'b'.repeat(64),
  'subscription-trusted-control-boundary-probe.py': 'c'.repeat(64) };
const ingressHashes: Record<string, string> = { ...trustedControlHashes,
  'subscription-trusted-ingress-child.py': 'd'.repeat(64), 'subscription-trusted-ingress-worker-probe.py': 'e'.repeat(64) };
const ingressFd = { fd: 198, socket: { dev: 1, ino: 42, type: 49152, family: 1, socketType: 1 },
  bootstrapInheritance: 'trusted-setup-only', preservedAcrossPivot: true };
it.each(['missing', 'malformed', 'extra'])('rejects %s optional ingress image metadata', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' }), helpers = { ...ingressHashes };
  if (kind === 'missing') delete helpers['subscription-trusted-ingress-child.py'];
  if (kind === 'malformed') helpers['subscription-trusted-ingress-worker-probe.py'] = 'invalid';
  if (kind === 'extra') helpers['extra.py'] = 'a'.repeat(64);
  f.frame({ ...f.ready, trustedIngressBoundary: { helperSha256: helpers } });
  f.child.emit('close', 1, null);
  expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown' });
});
it.each([{ fd: 197 }, { preservedAcrossPivot: false }, { socket: { ...ingressFd.socket, type: 4096 } },
  { socket: { ...ingressFd.socket, family: 2 } }, { socket: { ...ingressFd.socket, ino: 0 } }])(
  'rejects invalid optional ingress descriptor metadata %j', async change => {
    const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
    f.frame({ ...f.ready, trustedIngressFd: { ...ingressFd, ...change } });
    f.child.emit('close', 1, null);
    expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown' });
  });
it.each(['missing', 'malformed', 'extra'])('rejects %s optional trusted control image metadata', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  const helpers = { ...trustedControlHashes };
  if (kind === 'missing') delete helpers['subscription-trusted-control-boundary-parent.py'];
  if (kind === 'malformed') helpers['subscription-trusted-control-boundary-probe.py'] = 'invalid';
  if (kind === 'extra') helpers['extra.py'] = 'a'.repeat(64);
  f.frame({ ...f.ready, trustedControlBoundary: { helperSha256: helpers } });
  f.child.emit('close', 1, null);
  expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown' });
});

it.each(['missing', 'malformed', 'extra'])('rejects %s optional executor image metadata', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  const helpers = { ...execWorkerHashes };
  if (kind === 'missing') delete helpers['subscription-exec-worker-probe.py'];
  if (kind === 'malformed') helpers['subscription-exec-worker-probe.py'] = 'invalid';
  if (kind === 'extra') helpers['extra.py'] = 'a'.repeat(64);
  f.frame({ ...f.ready, execServerWorkerBoundary: { helperSha256: helpers } });
  f.child.emit('close', 1, null);
  expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown' });
});
it.each(['missing', 'malformed', 'extra'])('rejects %s optional environment image metadata', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  const helpers: Record<string, string> = { ...execWorkerHashes, 'subscription-exec-environment-metadata-parent.py': 'b'.repeat(64) };
  if (kind === 'missing') delete helpers['subscription-exec-environment-metadata-parent.py'];
  if (kind === 'malformed') helpers['subscription-exec-environment-metadata-parent.py'] = 'invalid';
  if (kind === 'extra') helpers['extra.py'] = 'a'.repeat(64);
  f.frame({ ...f.ready, execEnvironmentMetadataBoundary: { helperSha256: helpers } });
  f.child.emit('close', 1, null);
  expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown' });
});

it('accepts additional bounded worker image metadata without granting a worker mode', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.frame({ ...f.ready, workerBoundary, utsBoundary: { hostname: 'reality-compiler-probe', namespace: 'uts:[300]' },
    execServerWorkerBoundary: { helperSha256: execWorkerHashes },
    trustedControlBoundary: { helperSha256: trustedControlHashes },
    trustedIngressBoundary: { helperSha256: ingressHashes }, trustedIngressFd: ingressFd,
    execEnvironmentMetadataBoundary: { helperSha256: { ...execWorkerHashes, 'subscription-exec-environment-metadata-parent.py': 'b'.repeat(64) } },
    appServerMetadataPipeBoundary: { helperSha256: metadataPipeHashes },
    appServerFixtureBoundary: { helperSha256: { 'subscription-appserver-fixture-child.py': 'e'.repeat(64),
      'subscription-worker-lockdown.py': 'f'.repeat(64) } },
    appServerBoundary: { helperSha256: { 'subscription-appserver-noenv.py': 'c'.repeat(64), 'subscription-text-model-catalog.json': 'd'.repeat(64) } } });
  f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 });
  f.frame(f.terminal); f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'completed', cleanup: 'verified', productionReady: false });
  expect(f.commands()).toContain('"mode":"version"');
  expect(f.commands()).not.toContain('worker-boundary');
  expect(f.commands()).not.toContain('appserver-metadata-pipe');
});

it.each(['missing', 'malformed', 'extra'])('rejects %s metadata-pipe hash fields before legacy dispatch', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  const helperSha256: Record<string, string> = { ...metadataPipeHashes };
  if (kind === 'missing') delete helperSha256['subscription-worker-lockdown.py'];
  if (kind === 'malformed') helperSha256['subscription-appserver-metadata-pipe-child.py'] = 'not-a-sha256';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...f.ready, appServerMetadataPipeBoundary: { helperSha256 } }); f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'failed', error: 'INVALID_FRAME', cleanup: 'unknown' });
  expect(f.commands()).not.toContain('"type":"start"');
});

it.each(['missing', 'malformed', 'extra'])('rejects %s fixture lockdown metadata before a legacy probe starts', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  const helperSha256: Record<string, string> = { 'subscription-appserver-fixture-child.py': 'e'.repeat(64),
    'subscription-worker-lockdown.py': 'f'.repeat(64) };
  if (kind === 'missing') delete helperSha256['subscription-worker-lockdown.py'];
  if (kind === 'malformed') helperSha256['subscription-worker-lockdown.py'] = 'not-a-sha256';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...f.ready, appServerFixtureBoundary: { helperSha256 } });
  f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'failed', error: 'INVALID_FRAME', cleanup: 'unknown' });
  expect(f.commands()).not.toContain('"type":"start"');
});

it.each(['worker', 'appserver', 'uts', 'appserver-fixture'])('rejects malformed %s metadata on the trusted ready channel before dispatch', async kind => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  const invalid = kind === 'worker' ? { workerBoundary: { ...workerBoundary, helperSha256: { arbitrary: 'a'.repeat(64) } } }
    : kind === 'uts' ? { utsBoundary: { hostname: 'host-machine', namespace: 'uts:[300]' } }
    : kind === 'appserver-fixture' ? { appServerFixtureBoundary: { helperSha256: { arbitrary: 'a'.repeat(64) } } }
    : { appServerBoundary: { helperSha256: { arbitrary: 'a'.repeat(64) } } };
  f.frame({ ...f.ready, ...invalid });
  f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'failed' });
  expect(f.commands()).not.toContain('"type":"start"');
});
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  let commands = ''; child.stdin.on('data', value => { commands += value.toString(); });
  const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  const ready = { version: 1, type: 'ready', sandbox: { pidNamespaceInit: true, hostHomeMounted: false, hostMntMounted: false,
    networkInterfaces: ['lo'], uid: 1000, gid: 1000, ttyIsNullDevice: true, runtimeWriteDenied: true, parentNondumpable: true },
    binarySha256: 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
    bwrapSha256: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
    limits: { jobMs: 180000, commandMs: 200000, termGraceMs: 5000, maxOutputBytes: 8388608,
      commandBudgetEnforcedHere: false, aggregateResourcesEnforced: false } };
  const terminal = { version: 1, type: 'terminal', reason: 'EXITED', mode: 'version', exitCode: 0, elapsedMs: 20,
    outputBytes: 0, observedOutputSha256: createHash('sha256').update('').digest('hex'), outputComplete: true,
    streamEOF: { stdout: true, stderr: true }, outputLimitExceeded: false, registryOverflow: false,
    cleanup: { verified: true, namespaceEmpty: true, observedPidfds: 1, allObservedPidfdsESRCH: true, killSent: false, signalFailures: [] },
    privateChecks: null, credentialFilesRead: false, modelCalls: 0, productionReady: false,
    productionAuth: 'NOT_RUN', productionNetwork: 'NOT_RUN', productionCleanup: 'NOT_RUN' };
  return { child, frame, ready, terminal, commands: () => commands };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it('uses only fixed WSL capsule argv and completes after verified terminal and local close', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.frame(f.ready); f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 }); f.frame(f.terminal);
  expect(f.commands()).toContain('"mode":"version"');
  const args = vi.mocked(spawn).mock.calls[0][1] as string[];
  expect(args).toContain('-i'); expect(args).toContain('--map-current-user'); expect(args).toContain('--uts'); expect(args).not.toContain('login');
  expect(args).not.toContain('exec --model');
  f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'completed', cleanup: 'verified', productionReady: false, modelCalls: 0 });
});
it('does not spawn for pre-abort or an unknown operation', async () => {
  expect(await runCliSupervisorProbe({ mode: 'version', signal: AbortSignal.abort() })).toMatchObject({ outcome: 'not-started' });
  await expect(runCliSupervisorProbe({ mode: 'login' as 'version' })).rejects.toThrow('INVALID_CLI_PROBE_MODE');
  expect(spawn).not.toHaveBeenCalled();
});
it('keeps opaque child output from impersonating a terminal and verifies bytes/hash', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.frame(f.ready); f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 });
  const raw = JSON.stringify(f.terminal);
  f.frame({ version: 1, type: 'child_output', stream: 'stdout', encoding: 'base64', data: Buffer.from(raw).toString('base64') });
  f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ error: 'TERMINAL_MISSING', cleanup: 'unknown', stdout: raw });
});
it.each(['missing-start', 'wrong-hash', 'bad-cleanup', 'wrong-runtime', 'nonzero-exit', 'incomplete-output', 'overflow'])('rejects %s success evidence', async mode => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  if (mode === 'wrong-runtime') f.ready.binarySha256 = 'a'.repeat(64);
  f.frame(f.ready);
  if (mode !== 'missing-start') f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 });
  if (mode === 'wrong-hash') f.terminal.observedOutputSha256 = 'b'.repeat(64);
  if (mode === 'bad-cleanup') f.terminal.cleanup.namespaceEmpty = false;
  if (mode === 'nonzero-exit') f.terminal.exitCode = 7;
  if (mode === 'incomplete-output') { f.terminal.outputComplete = false; f.terminal.streamEOF.stderr = false; }
  if (mode === 'overflow') f.terminal.outputLimitExceeded = true;
  f.frame(f.terminal); f.child.emit('close', 0, null);
  expect((await pending).outcome).toBe('failed');
});
it('sends cancel and leaves the wrapper alive until acknowledged cleanup', async () => {
  const f = fixture(), control = new AbortController(), pending = runCliSupervisorProbe({ mode: 'version', signal: control.signal });
  f.frame(f.ready); f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 }); control.abort();
  expect(f.commands()).toContain('"type":"cancel"'); expect(f.child.kill).not.toHaveBeenCalled();
  f.frame({ ...f.terminal, reason: 'CANCELLED', exitCode: -15 }); f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'cancelled', cleanup: 'verified' });
});
it('does not drop one-shot start/cancel under control backpressure', async () => {
  const f = fixture(), controller = new AbortController();
  Object.defineProperty(f.child.stdin, 'writableNeedDrain', { get: () => true });
  const pending = runCliSupervisorProbe({ mode: 'version', signal: controller.signal });
  f.frame(f.ready); controller.abort();
  expect(f.commands()).toContain('"type":"start"'); expect(f.commands()).toContain('"type":"cancel"');
  f.frame({ ...f.terminal, reason: 'CANCELLED', exitCode: -15 }); f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'cancelled', cleanup: 'verified' });
});
it('cancels during capsule setup without ever sending start', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = runCliSupervisorProbe({ mode: 'version', signal: controller.signal }); controller.abort();
  f.frame(f.ready); f.frame({ ...f.terminal, reason: 'CANCELLED', mode: null, exitCode: null }); f.child.emit('close', 0, null);
  expect(f.commands()).not.toContain('"type":"start"');
  expect(await pending).toMatchObject({ outcome: 'cancelled', cleanup: 'verified' });
});
it('rejects a null terminal mode after actual start', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.frame(f.ready); f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 });
  f.frame({ ...f.terminal, mode: null }); f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'failed', error: 'TERMINAL_MODE_MISMATCH', cleanup: 'unknown' });
});
it('requires an owned stopped-CLI fixture event to follow its matching started mode', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.frame(f.ready); f.frame({ version: 1, type: 'fixture_ready', mode: 'stopped-cli', kind: 'owned-cli-stopped',
    pid: 2, executable: '/usr/bin/codex', state: 'T', signal: 'SIGSTOP', sinceStartMs: 5 });
  f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ error: 'INVALID_FIXTURE_READY', cleanup: 'unknown' });
});
it('does not promote output preceding start into completed success', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.frame(f.ready); f.frame({ version: 1, type: 'child_output', stream: 'stdout', encoding: 'base64', data: 'eA==' });
  f.frame({ version: 1, type: 'started', mode: 'version', pid: 2 });
  f.frame({ ...f.terminal, outputBytes: 1, observedOutputSha256: createHash('sha256').update('x').digest('hex') }); f.child.emit('close', 0, null);
  expect(await pending).toMatchObject({ outcome: 'failed', error: 'CLI_PROBE_FAILED', cleanup: 'verified' });
});
it('keeps cleanup unknown when cancellation receives no terminal', async () => {
  vi.useFakeTimers(); const f = fixture(), control = new AbortController();
  const pending = runCliSupervisorProbe({ mode: 'sleep', signal: control.signal }); f.frame(f.ready); control.abort();
  await vi.advanceTimersByTimeAsync(10000); expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  f.child.emit('close', null, 'SIGKILL');
  expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown', error: 'TERMINAL_TIMEOUT' });
});
it('bounds partial frames without continuing to accumulate rejected output', async () => {
  const f = fixture(), pending = runCliSupervisorProbe({ mode: 'version' });
  f.child.stdout.write('x'.repeat(65537)); f.child.stdout.write('y'.repeat(100000)); f.child.emit('close', 1, null);
  expect(await pending).toMatchObject({ outcome: 'failed', cleanup: 'unknown', error: 'FRAME_LIMIT', stdout: '' });
});
