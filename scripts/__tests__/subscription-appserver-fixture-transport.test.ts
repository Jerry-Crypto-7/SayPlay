import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
import { createAppServerFixtureTransport, createSystemdAppServerFixtureTransport, createSystemdAppServerMetadataPipeTransport } from '../subscription-appserver-fixture-transport';
import { createAppServerGenerationAdapter } from '../subscription-appserver-generation';

const helperSha256 = { 'subscription-worker-lockdown.py': createHash('sha256').update(readFileSync(new URL('../subscription-worker-lockdown.py', import.meta.url))).digest('hex'), 'subscription-appserver-fixture-child.py': createHash('sha256').update(readFileSync(new URL('../subscription-appserver-fixture-child.py', import.meta.url))).digest('hex') };
const metadataPipeHashes = { 'subscription-appserver-metadata-pipe-child.py': 'a'.repeat(64),
  'subscription-appserver-noenv.py': 'b'.repeat(64), 'subscription-worker-lockdown.py': 'c'.repeat(64),
  'subscription-text-model-catalog.json': 'd'.repeat(64) };
const ready = { version: 1, type: 'ready', utsBoundary: { hostname: 'reality-compiler-probe', namespace: 'uts:[123]' },
  trustedIngressBoundary: { helperSha256: Object.fromEntries([
    'subscription-trusted-ingress-child.py', 'subscription-trusted-ingress-worker-probe.py',
    'subscription-trusted-control-boundary-parent.py', 'subscription-trusted-control-boundary-probe.py',
    'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
    'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json'].map(name => [name, 'a'.repeat(64)])) },
  trustedControlBoundary: { helperSha256: Object.fromEntries([
    'subscription-trusted-control-boundary-parent.py', 'subscription-trusted-control-boundary-probe.py',
    'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
    'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json'].map(name => [name, 'a'.repeat(64)])) },
  execEnvironmentMetadataBoundary: { helperSha256: Object.fromEntries([
    'subscription-exec-environment-metadata-parent.py',
    'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
    'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json'].map(name => [name, 'a'.repeat(64)])) },
  execServerWorkerBoundary: { helperSha256: Object.fromEntries([
    'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
    'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json'].map(name => [name, 'a'.repeat(64)])) },
  appServerMetadataPipeBoundary: { helperSha256: metadataPipeHashes },
  appServerFixtureBoundary: { helperSha256 },
  sandbox: { pidNamespaceInit: true, hostHomeMounted: false, hostMntMounted: false, networkInterfaces: ['lo'], uid: 1000, gid: 1000,
    ttyIsNullDevice: true, runtimeWriteDenied: true, parentNondumpable: true },
  binarySha256: 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
  bwrapSha256: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
  limits: { jobMs: 180000, commandMs: 200000, termGraceMs: 5000, maxOutputBytes: 8388608,
    commandBudgetEnforcedHere: false, aggregateResourcesEnforced: false } };
function fixture(systemd = false, metadata = false) {
  const sent: Record<string, unknown>[] = [];
  const process = Object.assign(new EventEmitter(), { stdin: new Writable({ write(chunk, _encoding, callback) {
    sent.push(JSON.parse(chunk.toString())); callback();
  } }), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() });
  mocked.spawn.mockReturnValue(process);
  const observe = vi.fn(), output = vi.fn(), accounting = vi.fn(), controller = new AbortController();
  const factory = metadata ? createSystemdAppServerMetadataPipeTransport(observe) :
    (systemd ? createSystemdAppServerFixtureTransport : createAppServerFixtureTransport)('normal', observe);
  const transport = factory({ onOutput: output, onOutputAccounting: accounting }, controller.signal);
  const frame = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const own = (receipt = resourceReceipt()) => frame({ version: 1, type: 'systemd_ownership', ownership: ownershipOf(receipt) });
  const begin = () => { frame(ready); frame({ version: 1, type: 'started', mode: 'appserver-fixture', pid: 2 }); };
  const terminal = (change = {}) => frame({ version: 1, type: 'terminal', reason: 'CANCELLED', mode: metadata ? 'appserver-metadata-pipe' : 'appserver-fixture', exitCode: -15,
    elapsedMs: 20, outputBytes: 0, observedOutputSha256: createHash('sha256').digest('hex'), outputComplete: true,
    streamEOF: { stdout: true, stderr: true }, outputLimitExceeded: false, registryOverflow: false,
    cleanup: { verified: true, namespaceEmpty: true, observedPidfds: 2, allObservedPidfdsESRCH: true, killSent: false, signalFailures: [] },
    privateChecks: null, credentialFilesRead: false, modelCalls: 0, productionReady: false,
    productionAuth: 'NOT_RUN', productionNetwork: 'NOT_RUN', productionCleanup: 'NOT_RUN', ...change });
  const close = () => process.emit('close', 0, null);
  return { sent, process, observe, output, accounting, controller, transport, frame, own, begin, terminal, close };
}

function ownershipOf(receipt: ReturnType<typeof resourceReceipt>) {
  return { unit: receipt.unit, uid: receipt.uid, leaf: receipt.leaf, driverPid: receipt.control.driverPid,
    relaySha256: receipt.relaySha256, probeSha256: receipt.probeSha256 };
}

function resourceReceipt() {
  const unit = 'codex-cli-resource-' + 'a'.repeat(32) + '.service';
  const group = '/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit;
  return { unit, uid: 1000, leaf: '/sys/fs/cgroup' + group,
    aggregateResourceReadbackValidated: true, candidateExhaustionValidated: false,
    relaySha256: createHash('sha256').update(readFileSync(new URL('../subscription-systemd-fixture-transport.py', import.meta.url))).digest('hex'),
    probeSha256: createHash('sha256').update(readFileSync(new URL('../subscription-systemd-cli-probe.py', import.meta.url))).digest('hex'),
    limits: { memoryMaxBytes: 2147483648, swapMaxBytes: 0, tasksMax: 64, guardianMs: 220000, termGraceMs: 5000, innerCommandMs: 200000 },
    control: { driverPid: 100, driverCgroup: '/user.slice/session.scope', managerPid: 101, managerCgroup: '/user.slice/init.scope',
      managerUid: 1000, managerGid: 1000, managerIdentityProfile: 'private-socket-peer-v1', managerStartTimeTicks: '4567',
      managerSocket: { path: '/run/user/1000/systemd/private', components: Array.from({ length: 5 }, (_, i) => ({ dev: 1, ino: i + 1, mode: i === 4 ? 0xc180 : 0x41ed, uid: i > 1 ? 1000 : 0, gid: i > 1 ? 1000 : 0 })) },
      unitMainPid: 102, unitMainCgroup: group, unitMainStartTimeTicks: '12345' }, readback: { memoryMax: '2147483648', memorySwapMax: '0', pidsMax: '64' } };
}

function metadataReady(receipt: ReturnType<typeof resourceReceipt>) {
  const hashes = Object.fromEntries(Object.keys(metadataPipeHashes).map(name => [name,
    createHash('sha256').update(readFileSync(new URL('../' + name, import.meta.url))).digest('hex')]));
  return { ...ready, appServerMetadataPipeBoundary: { helperSha256: hashes }, systemdFixtureBoundary: receipt };
}

it('fixed systemd metadata profile binds four helpers without a fixture scenario and reports before cleanup continuations', async () => {
  const f = fixture(true, true), receipt = resourceReceipt(), frame = metadataReady(receipt);
  f.own(receipt); f.frame(frame);
  expect(mocked.spawn.mock.calls[0][1]).toContain('--metadata-pipe');
  expect(f.sent.find(frame => frame.type === 'start')).toEqual({ type: 'start', mode: 'appserver-metadata-pipe',
    helperSha256: frame.appServerMetadataPipeBoundary.helperSha256 });
  f.frame({ version: 1, type: 'started', mode: 'appserver-metadata-pipe', pid: 2 });
  f.transport.close();
  const continuation = f.transport.cleanup.then(cleanup => {
    expect(f.observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'ACTUAL_METADATA_PROTOCOL',
      aggregateResourcesValidated: true, actualModelCalls: 0, productionReady: false }));
    return cleanup;
  });
  f.terminal({ systemdFixtureBoundary: { ...receipt, preStartReadback: receipt.readback,
    cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true }, relayErrors: [] } }); f.close();
  expect(await continuation).toEqual({ local: 'confirmed', remote: 'confirmed' });
});

it.each(['missing-field', 'two-hashes', 'wrong-hash', 'extra-hash'])('metadata %s cannot start the resource pipe', async kind => {
  const f = fixture(true, true), receipt = resourceReceipt(), frame = metadataReady(receipt);
  f.own(receipt);
  if (kind === 'missing-field') Reflect.deleteProperty(frame, 'appServerMetadataPipeBoundary');
  if (kind === 'two-hashes') frame.appServerMetadataPipeBoundary.helperSha256 = { ...helperSha256 };
  if (kind === 'wrong-hash') frame.appServerMetadataPipeBoundary.helperSha256['subscription-worker-lockdown.py'] = '0'.repeat(64);
  if (kind === 'extra-hash') frame.appServerMetadataPipeBoundary.helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame(frame); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0].aggregateResourcesValidated).toBe(false);
});

it.each(['started', 'terminal'])('metadata rejects a foreign fixture %s mode despite valid resource identity', async stage => {
  const f = fixture(true, true), receipt = resourceReceipt(); f.own(receipt); f.frame(metadataReady(receipt));
  if (stage === 'started') f.frame({ version: 1, type: 'started', mode: 'appserver-fixture', pid: 2 });
  else {
    f.frame({ version: 1, type: 'started', mode: 'appserver-metadata-pipe', pid: 2 });
    f.terminal({ mode: 'appserver-fixture', systemdFixtureBoundary: { ...receipt, preStartReadback: receipt.readback,
      cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true }, relayErrors: [] } });
  }
  f.close(); expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0].aggregateResourcesValidated).toBe(false);
});

it('metadata readiness alone never grants aggregate cleanup credit', async () => {
  const f = fixture(true, true), receipt = resourceReceipt(); f.own(receipt); f.frame(metadataReady(receipt));
  f.frame({ version: 1, type: 'started', mode: 'appserver-metadata-pipe', pid: 2 }); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0].aggregateResourcesValidated).toBe(false);
});

it.each(['missing', 'malformed', 'extra'])('rejects %s optional ingress hashes before fixture dispatch', async kind => {
  const f = fixture(), helperSha256 = { ...ready.trustedIngressBoundary.helperSha256 };
  if (kind === 'missing') delete helperSha256['subscription-trusted-ingress-child.py'];
  if (kind === 'malformed') helperSha256['subscription-trusted-ingress-worker-probe.py'] = 'invalid';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...ready, trustedIngressBoundary: { helperSha256 } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it.each(['missing', 'malformed', 'extra'])('rejects %s optional trusted control hashes before fixture dispatch', async kind => {
  const f = fixture(), helperSha256 = { ...ready.trustedControlBoundary.helperSha256 };
  if (kind === 'missing') delete helperSha256['subscription-trusted-control-boundary-parent.py'];
  if (kind === 'malformed') helperSha256['subscription-trusted-control-boundary-probe.py'] = 'invalid';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...ready, trustedControlBoundary: { helperSha256 } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it.each(['missing', 'malformed', 'extra'])('rejects %s optional environment hash fields before fixture dispatch', async kind => {
  const f = fixture(), helperSha256 = { ...ready.execEnvironmentMetadataBoundary.helperSha256 };
  if (kind === 'missing') delete helperSha256['subscription-exec-environment-metadata-parent.py'];
  if (kind === 'malformed') helperSha256['subscription-exec-environment-metadata-parent.py'] = 'invalid';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...ready, execEnvironmentMetadataBoundary: { helperSha256 } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it.each(['missing', 'malformed', 'extra'])('rejects %s optional executor hash fields before fixture dispatch', async kind => {
  const f = fixture(), helperSha256: Record<string, string> = Object.fromEntries([
    'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
    'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json'].map(name => [name, 'a'.repeat(64)]));
  if (kind === 'missing') delete helperSha256['subscription-worker-lockdown.py'];
  if (kind === 'malformed') helperSha256['subscription-exec-worker-probe.py'] = 'not-a-sha256';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...ready, execServerWorkerBoundary: { helperSha256 } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it.each(['missing', 'malformed', 'extra'])('rejects %s optional metadata-pipe hash fields before fixture dispatch', async kind => {
  const f = fixture(), helperSha256: Record<string, string> = { ...metadataPipeHashes };
  if (kind === 'missing') delete helperSha256['subscription-worker-lockdown.py'];
  if (kind === 'malformed') helperSha256['subscription-appserver-metadata-pipe-child.py'] = 'not-a-sha256';
  if (kind === 'extra') helperSha256['arbitrary.py'] = 'a'.repeat(64);
  f.frame({ ...ready, appServerMetadataPipeBoundary: { helperSha256 } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it('systemd factory uses only fixed relay argv and confirms matching admission plus unit cleanup', async () => {
  const f = fixture(true), receipt = resourceReceipt();
  f.own(receipt);
  f.frame({ ...ready, systemdFixtureBoundary: receipt });
  f.frame({ version: 1, type: 'started', mode: 'appserver-fixture', pid: 2 });
  expect(mocked.spawn.mock.calls[0][1]).toContain('/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py');
  expect(f.sent.find(frame => frame.type === 'start')).toMatchObject({ mode: 'appserver-fixture', scenario: 'normal' });
  f.transport.close(); f.terminal({ systemdFixtureBoundary: { ...receipt, preStartReadback: receipt.readback,
    cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true }, relayErrors: [] } }); f.close();
  expect(await f.transport.cleanup).toEqual({ local: 'confirmed', remote: 'confirmed' });
  expect(f.observe.mock.calls[0][0]).toMatchObject({ aggregateResourcesValidated: true, actualModelCalls: 0, productionReady: false });
});

it.each(['missing', 'hash', 'inside-leaf', 'limits', 'manager-uid', 'manager-owner'])('systemd %s ready cannot dispatch', async kind => {
  const f = fixture(true), receipt = resourceReceipt();
  f.own();
  if (kind === 'hash') receipt.relaySha256 = '0'.repeat(64);
  if (kind === 'inside-leaf') receipt.control.driverCgroup = receipt.control.unitMainCgroup;
  if (kind === 'limits') receipt.readback.pidsMax = '65';
  if (kind === 'manager-uid') receipt.control.managerUid = 0;
  if (kind === 'manager-owner') receipt.control.managerIdentityProfile = 'public-bus';
  f.frame({ ...ready, ...(kind === 'missing' ? {} : { systemdFixtureBoundary: receipt }) }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it.each(['missing', 'unit', 'prestart', 'leaf', 'relay-error'])('systemd %s terminal cannot claim unit cleanup', async kind => {
  const f = fixture(true), receipt = resourceReceipt();
  f.own(receipt);
  f.frame({ ...ready, systemdFixtureBoundary: receipt }); f.frame({ version: 1, type: 'started', mode: 'appserver-fixture', pid: 2 });
  const terminal = { ...receipt, preStartReadback: { ...receipt.readback },
    cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true }, relayErrors: [] as string[] };
  if (kind === 'unit') terminal.unit = 'codex-cli-resource-' + 'b'.repeat(32) + '.service';
  if (kind === 'prestart') terminal.preStartReadback.memorySwapMax = '1';
  if (kind === 'leaf') terminal.cleanup.leafAbsent = false;
  if (kind === 'relay-error') terminal.relayErrors.push('cleanup unknown');
  f.terminal(kind === 'missing' ? {} : { systemdFixtureBoundary: terminal }); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: null });
  expect(f.observe.mock.calls[0][0].aggregateResourcesValidated).toBe(false);
});

it('systemd ownership is archived before ready without permitting start', async () => {
  const f = fixture(true), receipt = resourceReceipt(); f.own(receipt);
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  f.close(); await f.transport.cleanup;
  expect(f.observe.mock.calls[0][0]).toMatchObject({ ready: null, systemdOwnership: ownershipOf(receipt) });
});

it.each(['missing', 'wrong'])('requires %s lockdown helper identity before start', async kind => {
  const f = fixture();
  const helpers: Record<string, string> = { ...helperSha256 };
  if (kind === 'missing') delete helpers['subscription-worker-lockdown.py'];
  else helpers['subscription-worker-lockdown.py'] = '0'.repeat(64);
  f.frame({ ...ready, appServerFixtureBoundary: { helperSha256: helpers } }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it('start binds both current authored child and lockdown sources', async () => {
  const f = fixture(); f.begin();
  expect(f.sent.find(frame => frame.type === 'start')?.helperSha256).toEqual(helperSha256);
  f.close(); await f.transport.cleanup;
});

it.each(['path', 'symlink', 'not-socket', 'owner', 'missing-component'])('rejects invalid private socket %s metadata before dispatch', async kind => {
  const f = fixture(true), receipt = resourceReceipt(); f.own(receipt);
  const socket = receipt.control.managerSocket;
  if (kind === 'path') socket.path = '/run/user/0/systemd/private';
  if (kind === 'symlink') socket.components[1].mode = 0xa1ff;
  if (kind === 'not-socket') socket.components[4].mode = 0x81a4;
  if (kind === 'owner') socket.components[4].uid = 0;
  if (kind === 'missing-component') socket.components.pop();
  f.frame({ ...ready, systemdFixtureBoundary: receipt }); f.close();
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it('pre-ready systemd failure preserves bounded reason, ownership and actual cleanup without ready credit', async () => {
  const f = fixture(true), receipt = resourceReceipt(); f.own(receipt);
  const failure = { version: 1, type: 'systemd_failure', ownership: ownershipOf(receipt), error: 'ValueError:MANAGER_PARENT_REQUIRED',
    stageEvidence: null,
    cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true },
    diagnostics: { notSpawned: false, stderrPrefix: 'fixed diagnostic', stderrPrefixTruncated: false, stderrBytes: 16, stderrSha256: createHash('sha256').update('fixed diagnostic').digest('hex') } };
  f.frame(failure); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0]).toMatchObject({ error: 'SYSTEMD_RELAY_FAILURE:ValueError:MANAGER_PARENT_REQUIRED',
    ready: null, terminal: null, systemdFailure: failure });
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: null });
});

it('failure cannot replace the archived ownership with a different unit', async () => {
  const f = fixture(true), receipt = resourceReceipt(); f.own(receipt);
  f.frame({ version: 1, type: 'systemd_failure', ownership: { ...ownershipOf(receipt), unit: 'codex-cli-resource-' + 'b'.repeat(32) + '.service' },
    stageEvidence: null,
    error: 'foreign cleanup', cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true },
    diagnostics: { notSpawned: false, stderrPrefix: '', stderrPrefixTruncated: false, stderrBytes: 0, stderrSha256: createHash('sha256').digest('hex') } });
  f.close(); expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0].systemdOwnership).toEqual(ownershipOf(receipt));
  expect(f.observe.mock.calls[0][0].systemdFailure).toBeUndefined();
  expect(f.observe.mock.calls[0][0].error).toBe('FAILURE_OWNERSHIP_MISMATCH');
});

it('retains stage errno/timing and inner timeout terminal only as failure diagnostics', async () => {
  const f = fixture(true), receipt = resourceReceipt(); f.own(receipt);
  const inner = { version: 1, type: 'terminal', reason: 'START_TIMEOUT' };
  const stageEvidence = { events: [{ stage: 'main_pidfd_live_after', startedMs: 5000, durationMs: 1, outcome: 'error', errno: 3 }],
    eventsDropped: 0, mainPid: 123, manager: null,
    mainStat: { state: 'S', ppid: 406, startTimeTicks: '12345' }, mainStatErrno: null,
    relayState: { ready: false, started: false, terminal: false }, capsuleReadySeenMs: 100,
    capsuleFailureTerminal: { frame: inner, rawSha256: createHash('sha256').update(JSON.stringify(inner)).digest('hex'),
      rawBytes: Buffer.byteLength(JSON.stringify(inner)), canonicalBytes: Buffer.byteLength(JSON.stringify(inner)), omittedReason: null } };
  f.frame({ version: 1, type: 'systemd_failure', ownership: ownershipOf(receipt), error: 'ProcessLookupError:gone', stageEvidence,
    cleanup: { unitAbsent: true, leafAbsent: true, systemdRunClosed: true },
    diagnostics: { notSpawned: false, stderrPrefix: '', stderrPrefixTruncated: false, stderrBytes: 0, stderrSha256: createHash('sha256').digest('hex') } });
  f.close(); expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0].systemdFailure.stageEvidence).toEqual(stageEvidence);
  expect(f.observe.mock.calls[0][0].terminal).toBeNull();
});

it.each(['duplicate', 'wrong-hash', 'ready-first', 'basic'])('rejects %s ownership/admission misuse', async kind => {
  const f = fixture(kind !== 'basic'), receipt = resourceReceipt();
  if (kind === 'ready-first') f.frame({ ...ready, systemdFixtureBoundary: receipt });
  else {
    if (kind === 'wrong-hash') receipt.relaySha256 = '0'.repeat(64);
    f.own(receipt); if (kind === 'duplicate') f.own(receipt);
  }
  f.close(); expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
});
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it('uses fixed clean-env capsule argv and waits for actual input ack', async () => {
  const f = fixture(); f.begin(); const done = vi.fn();
  const send = f.transport.send({ id: 1, method: 'initialize', params: {} }).then(done);
  await flush(); expect(done).not.toHaveBeenCalled();
  const input = f.sent.find(frame => frame.type === 'fixture_input')!;
  expect(input.seq).toBe(1);
  expect(Buffer.from(input.data as string, 'base64').toString()).toBe('{"id":1,"method":"initialize","params":{}}\n');
  expect(mocked.spawn.mock.calls[0][1]).toContain('--uts');
  expect(mocked.spawn.mock.calls[0][1]).toContain('-i');
  f.frame({ version: 1, type: 'fixture_input_ack', seq: 1 }); await send;
  f.transport.close(); f.terminal(); f.close();
  expect(await f.transport.cleanup).toEqual({ local: 'confirmed', remote: 'confirmed' });
  expect(f.observe.mock.calls[0][0]).toMatchObject({ actualModelCalls: 0, productionReady: false });
});

it.each([0, 2, true])('rejects out-of-order ack %s without cleanup credit', async seq => {
  const f = fixture(); f.begin(); const failed = expect(f.transport.send({ id: 1 })).rejects.toThrow('FIXTURE_CLOSED');
  await flush(); f.frame({ version: 1, type: 'fixture_input_ack', seq }); f.terminal(); f.close(); await failed;
  expect(await f.transport.cleanup).toEqual({ local: 'confirmed', remote: 'unknown' });
});

it('rejects duplicate ack after a completed write', async () => {
  const f = fixture(); f.begin(); const send = f.transport.send({ id: 1 }); await flush();
  f.frame({ version: 1, type: 'fixture_input_ack', seq: 1 }); await send;
  f.frame({ version: 1, type: 'fixture_input_ack', seq: 1 }); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it.each(['cancel', 'eof'])('settles pending input on %s and never substitutes ack for cleanup', async kind => {
  const f = fixture(); f.begin(); const failed = expect(f.transport.send({ id: 1 })).rejects.toThrow('FIXTURE_CLOSED');
  await flush(); if (kind === 'cancel') f.controller.abort(); f.close(); await failed;
  expect((await f.transport.cleanup).remote).toBe('unknown');
});

it('rejects helper image mismatch before dispatch', async () => {
  const f = fixture(); f.frame({ ...ready, appServerFixtureBoundary: { helperSha256: { 'subscription-appserver-fixture-child.py': '0'.repeat(64) } } });
  f.close(); await f.transport.cleanup;
  expect(f.sent.some(frame => frame.type === 'start')).toBe(false);
});

it('reports terminal-only overflow without inventing raw bytes', async () => {
  const f = fixture(); f.begin(); f.terminal({ outputLimitExceeded: true, outputBytes: 8388609 }); f.close();
  expect((await f.transport.cleanup).remote).toBe('confirmed');
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: 8388609 });
  expect(f.output).not.toHaveBeenCalled();
});

it('does not confirm a truncated non-overlimit transcript even with a matching prefix hash', async () => {
  const f = fixture(); f.begin(); f.terminal({ outputComplete: false, streamEOF: { stdout: false, stderr: true } }); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.observe.mock.calls[0][0].error).toBe('OUTPUT_EVIDENCE');
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: null });
});

it('orders same-tick ack/raw/terminal/close as send, raw, watermark, cleanup', async () => {
  const f = fixture(); f.begin(); const order: string[] = [];
  const send = f.transport.send({ id: 1 }).then(() => { order.push('send'); }); await flush();
  f.output.mockImplementation(() => { order.push('raw'); });
  f.accounting.mockImplementation(() => { order.push('watermark'); });
  const cleaned = f.transport.cleanup.then(() => { order.push('cleanup'); });
  const bytes = Buffer.from('known raw\n');
  f.process.stdout.write(JSON.stringify({ version: 1, type: 'fixture_input_ack', seq: 1 }) + '\n' +
    JSON.stringify({ version: 1, type: 'child_output', stream: 'stdout', encoding: 'base64', data: bytes.toString('base64') }) + '\n');
  f.terminal({ outputBytes: bytes.length, observedOutputSha256: createHash('sha256').update(bytes).digest('hex') });
  f.close();
  expect(f.accounting).not.toHaveBeenCalled();
  await send; await cleaned;
  expect(order).toEqual(['send', 'raw', 'watermark', 'cleanup']);
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: bytes.length });
});

it('terminal withheld accounting reaches the adapter before cleanup and triggers OUTPUT_LIMIT', async () => {
  const f = fixture();
  const adapter = createAppServerGenerationAdapter(callbacks => {
    f.output.mockImplementation(callbacks.onOutput);
    f.accounting.mockImplementation(callbacks.onOutputAccounting!);
    return f.transport;
  });
  const pending = adapter.generate({ request: { model: 'gpt-5.6-sol', system: '', user: 'fixture' }, remainingBudgetMs: 10000 });
  f.begin(); await flush(); f.frame({ version: 1, type: 'fixture_input_ack', seq: 1 }); await flush();
  f.terminal({ outputLimitExceeded: true, outputBytes: 8388708 }); f.close();
  const result = await pending;
  expect(result.error).toBe('OUTPUT_LIMIT'); expect(result.outputBytes).toBe(0);
  expect(result.outputAccounting).toMatchObject({ receivedBytes: 0, observedBytes: 8388708, withheldBytes: 8388708, status: 'reported' });
  expect(result.wireRaw).toBe(''); expect(result.stderrRaw).toBe('');
});

it('cancelled input accepts a late terminal watermark without giving malformed terminals numeric credit', async () => {
  const f = fixture(); f.begin(); f.controller.abort();
  f.terminal({ outputBytes: Number.MAX_SAFE_INTEGER + 1 }); f.close();
  expect((await f.transport.cleanup).remote).toBe('unknown');
  expect(f.accounting).toHaveBeenCalledExactlyOnceWith({ observedBytes: null });
});

it('settles send before response delivery when ack and output share the same OS read', async () => {
  const f = fixture(); f.begin(); let delivered = false;
  const send = f.transport.send({ id: 1 }).then(() => { delivered = true; }); await flush();
  f.output.mockImplementation(() => expect(delivered).toBe(true));
  const bytes = Buffer.from('{"id":1}\n');
  f.process.stdout.write(JSON.stringify({ version: 1, type: 'fixture_input_ack', seq: 1 }) + '\n' +
    JSON.stringify({ version: 1, type: 'child_output', stream: 'stdout', encoding: 'base64', data: bytes.toString('base64') }) + '\n');
  await send; expect(f.output).not.toHaveBeenCalled();
  await new Promise(resolve => setImmediate(resolve)); expect(f.output).toHaveBeenCalledTimes(1);
  f.transport.close(); f.terminal({ outputBytes: bytes.length, observedOutputSha256: createHash('sha256').update(bytes).digest('hex') }); f.close();
  expect((await f.transport.cleanup).remote).toBe('confirmed');
});

it('accepts only the single in-flight ack after cancellation while still requiring pidfd cleanup', async () => {
  const f = fixture(); f.begin(); const rejected = expect(f.transport.send({ id: 1 })).rejects.toThrow('FIXTURE_CLOSED');
  await flush(); f.controller.abort(); f.frame({ version: 1, type: 'fixture_input_ack', seq: 1 });
  f.terminal(); f.close(); await rejected;
  expect((await f.transport.cleanup).remote).toBe('confirmed');
});

it('delivers the actual crossing chunk but the generation adapter never retains bytes over 8 MiB', async () => {
  const f = fixture();
  const adapter = createAppServerGenerationAdapter(callbacks => { f.output.mockImplementation(callbacks.onOutput); return f.transport; });
  const result = adapter.generate({ request: { model: 'gpt-5.6-sol', system: '', user: 'fixture' }, remainingBudgetMs: 10000 });
  f.begin(); await flush(); f.frame({ version: 1, type: 'fixture_input_ack', seq: 1 }); await flush();
  const data = Buffer.alloc(4096, 120).toString('base64');
  for (let i = 0; i < 2049; i++) f.frame({ version: 1, type: 'child_output', stream: 'stderr', encoding: 'base64', data });
  await new Promise(resolve => setImmediate(resolve));
  f.terminal({ outputLimitExceeded: true, outputBytes: 8388608 + 4096 }); f.close();
  const completed = await result;
  expect(completed.error).toBe('OUTPUT_LIMIT');
  expect(completed.outputBytes).toBe(8388608 + 4096);
  expect(Buffer.byteLength(completed.stderrRaw)).toBe(8388608);
  expect(f.observe.mock.calls[0][0]).not.toHaveProperty('stderr');
});

it('keeps real stdout and stderr bytes separate without storing bodies in transport evidence', async () => {
  const f = fixture(); f.begin();
  for (const stream of ['stdout', 'stderr']) f.frame({ version: 1, type: 'child_output', stream, encoding: 'base64', data: Buffer.from(stream).toString('base64') });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.output.mock.calls.map(call => [call[0], Buffer.from(call[1]).toString()])).toEqual([['stdout', 'stdout'], ['stderr', 'stderr']]);
  f.transport.close(); f.terminal({ outputBytes: 12, observedOutputSha256: createHash('sha256').update('stdoutstderr').digest('hex') }); f.close();
  expect((await f.transport.cleanup).remote).toBe('confirmed');
  expect(f.observe.mock.calls[0][0]).not.toHaveProperty('stdout');
});
