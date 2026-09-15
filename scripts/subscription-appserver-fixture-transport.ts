/** Fixed capsule pipes for authored fixtures and metadata-only CLI. No production dispatch. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { GenerationCleanup, GenerationTransportFactory } from './subscription-appserver-generation';

const count = z.number().int().safe().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const helperName = 'subscription-appserver-fixture-child.py';
const lockdownName = 'subscription-worker-lockdown.py';
const mode = 'appserver-fixture';
const metadataMode = 'appserver-metadata-pipe';
const ownershipSchema = z.object({ unit: z.string().regex(/^codex-cli-resource-[a-f0-9]{32}\.service$/), uid: count,
  leaf: z.string().max(4096), driverPid: count.min(2), relaySha256: hash, probeSha256: hash }).strict();
const managerIdentityShape = {
  managerIdentityProfile: z.literal('private-socket-peer-v1'), managerPid: count.min(2), managerUid: count, managerGid: count,
  managerStartTimeTicks: z.string().regex(/^[0-9]+$/).max(32), managerCgroup: z.string().max(4096),
  managerSocket: z.object({ path: z.string().max(4096), components: z.array(z.object({ dev: count, ino: count, mode: count,
    uid: count, gid: count }).strict()).length(5) }).strict(),
};
const stageEvidenceSchema = z.object({ events: z.array(z.object({ stage: z.string().max(64), startedMs: count, durationMs: count,
  outcome: z.enum(['ok', 'error']), errno: z.number().int().nullable() }).strict()).max(64), eventsDropped: count, mainPid: count.nullable(),
  manager: z.object(managerIdentityShape).strict().nullable(),
  mainStat: z.object({ state: z.string().max(1), ppid: count, startTimeTicks: z.string().regex(/^[0-9]+$/) }).strict().nullable(),
  mainStatErrno: z.number().int().nullable(), relayState: z.object({ ready: z.boolean(), started: z.boolean(), terminal: z.boolean() }).strict().nullable(),
  capsuleReadySeenMs: count.nullable(), capsuleFailureTerminal: z.object({ frame: z.record(z.string(), z.unknown()).nullable(), rawSha256: hash,
    rawBytes: count.max(65536), canonicalBytes: count, omittedReason: z.enum(['CANONICAL_TERMINAL_LIMIT', 'FAILURE_ENVELOPE_LIMIT']).nullable() }).strict().nullable(),

}).strict();
const systemdFailureSchema = z.object({ version: z.literal(1), type: z.literal('systemd_failure'), ownership: ownershipSchema,
  stageEvidence: stageEvidenceSchema.nullable(),
  error: z.string().max(1024), cleanup: z.object({ unitAbsent: z.boolean().nullable(), leafAbsent: z.boolean().nullable(),
    systemdRunClosed: z.boolean() }).strict(), diagnostics: z.object({ notSpawned: z.boolean(), stderrPrefix: z.string().max(4096), stderrPrefixTruncated: z.boolean(),
    stderrBytes: count, stderrSha256: hash }).strict() }).strict();
const resourceReadback = z.object({ memoryMax: z.literal('2147483648'), memorySwapMax: z.literal('0'), pidsMax: z.literal('64') }).strict();
const resourceBoundary = z.object({ unit: z.string().regex(/^codex-cli-resource-[a-f0-9]{32}\.service$/), uid: count,
  aggregateResourceReadbackValidated: z.literal(true), candidateExhaustionValidated: z.literal(false),
  leaf: z.string().max(4096), relaySha256: hash, probeSha256: hash,
  limits: z.object({ memoryMaxBytes: z.literal(2147483648), swapMaxBytes: z.literal(0), tasksMax: z.literal(64),
    guardianMs: z.literal(220000), termGraceMs: z.literal(5000), innerCommandMs: z.literal(200000) }).strict(),
  control: z.object({ driverPid: count.min(2), driverCgroup: z.string().max(4096), ...managerIdentityShape,
    unitMainPid: count.min(2), unitMainCgroup: z.string().max(4096),
    unitMainStartTimeTicks: z.string().regex(/^[0-9]+$/).max(32) }).strict(),
  readback: resourceReadback,
}).strict();
const resourceTerminal = resourceBoundary.extend({ preStartReadback: resourceReadback,
  cleanup: z.object({ unitAbsent: z.literal(true), leafAbsent: z.literal(true), systemdRunClosed: z.literal(true) }).strict(),
  relayErrors: z.array(z.string()).max(0),
}).strict();
const readySchema = z.object({ version: z.literal(1), type: z.literal('ready'),
  trustedIngressBoundary: z.object({ helperSha256: z.object({
    'subscription-trusted-ingress-child.py': hash,
    'subscription-trusted-ingress-worker-probe.py': hash,
    'subscription-trusted-control-boundary-parent.py': hash,
    'subscription-trusted-control-boundary-probe.py': hash,
    'subscription-exec-server-worker-gate.py': hash, 'subscription-exec-server-worker-trampoline.py': hash,
    'subscription-exec-worker-probe.py': hash, 'subscription-worker-lockdown.py': hash,
    'subscription-appserver-noenv.py': hash, 'subscription-text-model-catalog.json': hash,
  }).strict() }).strict().optional(),
  trustedIngressFd: z.object({ fd: z.literal(198),
    socket: z.object({ dev: count, ino: count.min(1), type: z.literal(49152), family: z.literal(1), socketType: z.literal(1) }).strict(),
    bootstrapInheritance: z.literal('trusted-setup-only'), preservedAcrossPivot: z.literal(true),
  }).strict().optional(),
  trustedControlBoundary: z.object({ helperSha256: z.object({
    'subscription-trusted-control-boundary-parent.py': hash,
    'subscription-trusted-control-boundary-probe.py': hash,
    'subscription-exec-server-worker-gate.py': hash, 'subscription-exec-server-worker-trampoline.py': hash,
    'subscription-exec-worker-probe.py': hash, 'subscription-worker-lockdown.py': hash,
    'subscription-appserver-noenv.py': hash, 'subscription-text-model-catalog.json': hash,
  }).strict() }).strict().optional(),
  execEnvironmentMetadataBoundary: z.object({ helperSha256: z.object({
    'subscription-exec-environment-metadata-parent.py': hash,
    'subscription-exec-server-worker-gate.py': hash, 'subscription-exec-server-worker-trampoline.py': hash,
    'subscription-exec-worker-probe.py': hash, 'subscription-worker-lockdown.py': hash,
    'subscription-appserver-noenv.py': hash, 'subscription-text-model-catalog.json': hash,
  }).strict() }).strict().optional(),
  execServerWorkerBoundary: z.object({ helperSha256: z.object({
    'subscription-exec-server-worker-gate.py': hash, 'subscription-exec-server-worker-trampoline.py': hash,
    'subscription-exec-worker-probe.py': hash, 'subscription-worker-lockdown.py': hash,
    'subscription-appserver-noenv.py': hash, 'subscription-text-model-catalog.json': hash,
  }).strict() }).strict().optional(),
  appServerMetadataPipeBoundary: z.object({ helperSha256: z.object({
    'subscription-appserver-metadata-pipe-child.py': hash, 'subscription-appserver-noenv.py': hash,
    'subscription-worker-lockdown.py': hash, 'subscription-text-model-catalog.json': hash,
  }).strict() }).strict().optional(),
  utsBoundary: z.object({ hostname: z.literal('reality-compiler-probe'), namespace: z.string().regex(/^uts:\[[1-9][0-9]*\]$/) }).strict(),
  appServerFixtureBoundary: z.object({ helperSha256: z.object({ [helperName]: hash, [lockdownName]: hash }).strict() }).strict(),
  sandbox: z.object({ pidNamespaceInit: z.literal(true), hostHomeMounted: z.literal(false), hostMntMounted: z.literal(false),
    networkInterfaces: z.tuple([z.literal('lo')]), uid: count, gid: count, ttyIsNullDevice: z.literal(true),
    runtimeWriteDenied: z.literal(true), parentNondumpable: z.literal(true) }).strict(),
  binarySha256: z.literal('a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'),
  bwrapSha256: z.literal('77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'),
  limits: z.object({ jobMs: z.literal(180000), commandMs: z.literal(200000), termGraceMs: z.literal(5000),
    maxOutputBytes: z.literal(8388608), commandBudgetEnforcedHere: z.literal(false), aggregateResourcesEnforced: z.literal(false) }).strict(),
  workerBoundary: z.unknown().optional(), appServerBoundary: z.unknown().optional(),
  systemdFixtureBoundary: resourceBoundary.optional(),
}).strict();
const terminalSchema = z.object({ version: z.literal(1), type: z.literal('terminal'), reason: z.string().nullable(),
  mode: z.enum([mode, metadataMode]).nullable(), exitCode: z.number().int().nullable(), elapsedMs: count, outputBytes: count,
  observedOutputSha256: hash, outputComplete: z.boolean(), streamEOF: z.object({ stdout: z.boolean(), stderr: z.boolean() }).strict(),
  outputLimitExceeded: z.boolean(), registryOverflow: z.boolean(),
  cleanup: z.object({ verified: z.boolean(), namespaceEmpty: z.boolean(), observedPidfds: count,
    allObservedPidfdsESRCH: z.boolean(), killSent: z.boolean(), signalFailures: z.array(z.object({ pid: count, errno: z.number().int() }).strict()).max(32) }).strict(),
  privateChecks: z.null(), credentialFilesRead: z.literal(false), modelCalls: z.literal(0), productionReady: z.literal(false),
  productionAuth: z.literal('NOT_RUN'), productionNetwork: z.literal('NOT_RUN'), productionCleanup: z.literal('NOT_RUN'),
  fixture: z.null().optional(), terminationElapsedMs: count.nullable().optional(),
  systemdFixtureBoundary: resourceTerminal.optional(),
}).strict();
export type FixtureScenario = 'normal' | 'cancel' | 'output-limit';
interface PipeEvidenceBase {
  actualModelCalls: 0; productionReady: false; credentialFilesRead: false;
  aggregateResourcesValidated: boolean; error: string | null; outputBytes: number;
  ready: unknown; terminal: unknown; localClose: { code: number | null; signal: string | null } | null;
  systemdOwnership?: unknown; systemdFailure?: unknown;
}
export interface FixtureEvidence extends PipeEvidenceBase { kind: 'AUTHORED_PROTOCOL_FIXTURE' }
export interface MetadataResourceEvidence extends PipeEvidenceBase { kind: 'ACTUAL_METADATA_PROTOCOL' }
type PipeProfile = 'fixture' | 'metadata';
type ProfileEvidence<P extends PipeProfile> = P extends 'fixture' ? FixtureEvidence : MetadataResourceEvidence;

/** Fixed executable, paths and environment. Scenario is an authored enum, never argv input. */
export function createAppServerFixtureTransport(scenario: FixtureScenario,
  observe?: (evidence: FixtureEvidence) => void): GenerationTransportFactory {
  return createFixedPipeTransport('basic', 'fixture', scenario, observe);
}

/** Candidate resource envelope, still authored fixture only; never production. */
export function createSystemdAppServerFixtureTransport(scenario: FixtureScenario,
  observe?: (evidence: FixtureEvidence) => void): GenerationTransportFactory {
  return createFixedPipeTransport('systemd', 'fixture', scenario, observe);
}

/** Raw fixed metadata pipe. The Python child independently rejects non-metadata
 * RPC; the metadata transport adds the same gate before any control write.
 * Historical systemdFixtureBoundary is the shared resource receipt field. */
export function createSystemdAppServerMetadataPipeTransport(
  observe?: (evidence: MetadataResourceEvidence) => void): GenerationTransportFactory {
  return createFixedPipeTransport('systemd', 'metadata', undefined, observe);
}

function createFixedPipeTransport<P extends PipeProfile>(launcher: 'basic' | 'systemd', profile: P,
  scenario: P extends 'fixture' ? FixtureScenario : undefined,
  observe?: (evidence: ProfileEvidence<P>) => void): GenerationTransportFactory {
  if (profile === 'fixture' && !['normal', 'cancel', 'output-limit'].includes(scenario as FixtureScenario))
    throw new Error('INVALID_FIXTURE_SCENARIO');
  const selectedMode = profile === 'fixture' ? mode : metadataMode;
  return (callbacks, signal) => {
    const evidence = { kind: profile === 'fixture' ? 'AUTHORED_PROTOCOL_FIXTURE' : 'ACTUAL_METADATA_PROTOCOL', actualModelCalls: 0, productionReady: false,
      credentialFilesRead: false, aggregateResourcesValidated: false, error: null, outputBytes: 0, ready: null, terminal: null, localClose: null } as ProfileEvidence<P>;
    if (signal.aborted) return { send: async () => { throw new Error('FIXTURE_CLOSED'); }, close() {},
      cleanup: Promise.resolve({ local: 'confirmed', remote: 'confirmed' }) };
    const helperNames = profile === 'fixture' ? [helperName, lockdownName] :
      ['subscription-appserver-metadata-pipe-child.py', 'subscription-appserver-noenv.py', lockdownName, 'subscription-text-model-catalog.json'];
    const helperHashes = Object.fromEntries(helperNames.map(name => [name,
      createHash('sha256').update(readFileSync(new URL('./' + name, import.meta.url))).digest('hex')]));
    const resourceHashes = launcher === 'systemd' ? {
      relay: createHash('sha256').update(readFileSync(new URL('./subscription-systemd-fixture-transport.py', import.meta.url))).digest('hex'),
      probe: createHash('sha256').update(readFileSync(new URL('./subscription-systemd-cli-probe.py', import.meta.url))).digest('hex'),
    } : null;
    const child = spawn('C:\\Windows\\System32\\wsl.exe', ['--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i',
      'PATH=/usr/bin:/bin', ...(launcher === 'systemd' ? ['/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py',
        ...(profile === 'metadata' ? ['--metadata-pipe'] : [])] : ['/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '200s',
      '/usr/bin/unshare', '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--uts', '--pid', '--fork',
      '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh'])],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let resolveCleanup!: (value: GenerationCleanup) => void;
    const cleanup = new Promise<GenerationCleanup>(resolve => { resolveCleanup = resolve; });
    let ready = false, started = false, stopped = false, sealed = false, invalid = false;
    let pendingOutputs = 0, finishRequested = false;
    let partial = '', wireBytes = 0, inputBytes = 0, sequence = 0;
    const decoder = new StringDecoder('utf8'), digest = createHash('sha256');
    let terminal: z.infer<typeof terminalSchema> | null = null;
    let resources: z.infer<typeof resourceBoundary> | null = null;
    let ownership: z.infer<typeof ownershipSchema> | null = null;
    let ack: { seq: number; resolve(): void; reject(error: Error): void } | null = null;
    let cancelledAck: number | null = null;
    let resolveStart!: () => void, rejectStart!: (error: Error) => void;
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    void start.catch(() => undefined);
    let writes = Promise.resolve();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => fail('COMMAND_DEADLINE'), 200000);
    const write = (frame: unknown) => new Promise<void>((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('CONTROL_CLOSED')); return; }
      child.stdin.write(JSON.stringify(frame) + '\n', error => error ? reject(error) : resolve());
    });
    const finish = () => {
      if (sealed) return;
      finishRequested = true;
      if (pendingOutputs !== 0) return;
      sealed = true;
      clearTimeout(deadline); clearTimeout(closeTimer); clearInterval(heartbeat); signal.removeEventListener('abort', close);
      rejectStart(new Error('FIXTURE_CLOSED')); ack?.reject(new Error('FIXTURE_CLOSED')); ack = null;
      // The aggregate watermark includes bytes withheld during PID1 drain. It
      // follows every deferred raw callback and precedes cleanup settlement.
      try { callbacks.onOutputAccounting?.({ observedBytes: !invalid && ready && started && terminal ? terminal.outputBytes : null }); }
      catch { invalid = true; evidence.error ??= 'ACCOUNTING_CALLBACK_FAILED'; }
      const verified = !invalid && ready && started && terminal?.cleanup.verified && terminal.cleanup.namespaceEmpty &&
        terminal.cleanup.allObservedPidfdsESRCH && terminal.cleanup.observedPidfds > 0 && !terminal.registryOverflow && !terminal.cleanup.signalFailures.length &&
        (launcher === 'basic' || !!terminal.systemdFixtureBoundary);
      evidence.aggregateResourcesValidated = launcher === 'systemd' && !!verified;
      resolveCleanup({ local: evidence.localClose ? 'confirmed' : 'unknown', remote: verified ? 'confirmed' : 'unknown' });
      try { observe?.(structuredClone(evidence)); } catch { /* Observation cannot create process credit. */ }
    };
    function close() {
      if (stopped || sealed) return; stopped = true; clearInterval(heartbeat);
      cancelledAck = ack?.seq ?? null;
      rejectStart(new Error('FIXTURE_CLOSED')); ack?.reject(new Error('FIXTURE_CLOSED')); ack = null;
      void write({ type: 'cancel' }).catch(() => undefined);
      // Linux PID1 gets its full five-second TERM grace plus reap/drain time.
      closeTimer = setTimeout(() => {
        evidence.error ??= 'TERMINAL_TIMEOUT'; child.kill('SIGKILL');
        closeTimer = setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(); }, 2000);
      }, launcher === 'systemd' ? 20000 : 10000);
    }
    function fail(error: string) { invalid = true; evidence.error ??= error; close(); }
    signal.addEventListener('abort', close, { once: true });
    child.on('error', () => fail('SPAWN_FAILED'));
    child.stdin.on('error', () => fail('CONTROL_PIPE_FAILED'));
    child.stderr.on('data', () => fail('WRAPPER_DIAGNOSTIC'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (sealed || invalid) return;
      wireBytes += chunk.length;
      if (wireBytes > 16 * 1024 * 1024) { fail('WIRE_LIMIT'); return; }
      partial += decoder.write(chunk);
      let newline: number;
      while ((newline = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
        if (Buffer.byteLength(line) > 65536) { fail('FRAME_LIMIT'); return; }
        try {
          const frame = JSON.parse(line);
          if (!frame || frame.version !== 1) throw new Error('FRAME_ORDER');
          if (frame.type === 'systemd_ownership') {
            if (launcher !== 'systemd' || ownership || ready || terminal) throw new Error('OWNERSHIP_FRAME_ORDER');
            const parsed = z.object({ version: z.literal(1), type: z.literal('systemd_ownership'), ownership: ownershipSchema }).strict().parse(frame).ownership;
            const expectedLeaf = `/sys/fs/cgroup/user.slice/user-${parsed.uid}.slice/user@${parsed.uid}.service/app.slice/${parsed.unit}`;
            if (parsed.leaf !== expectedLeaf || parsed.relaySha256 !== resourceHashes!.relay || parsed.probeSha256 !== resourceHashes!.probe) throw new Error('OWNERSHIP_IDENTITY');
            ownership = parsed; evidence.systemdOwnership = parsed;
            continue; // Ownership never permits start or input dispatch.
          }
          if (frame.type === 'systemd_failure') {
            if (launcher !== 'systemd' || !ownership || terminal) throw new Error('FAILURE_OWNERSHIP_MISSING');
            const parsed = systemdFailureSchema.parse(frame);
            if (JSON.stringify(parsed.ownership) !== JSON.stringify(ownership)) throw new Error('FAILURE_OWNERSHIP_MISMATCH');
            evidence.systemdFailure = parsed;
            throw new Error('SYSTEMD_RELAY_FAILURE:' + parsed.error);
          }
          if (terminal || (!ready && frame.type !== 'ready')) throw new Error('FRAME_ORDER');
          if (frame.type === 'ready') {
            if (ready) throw new Error('DUPLICATE_READY');
            const parsed = readySchema.parse(frame);
            const advertised: Record<string, string> | undefined = profile === 'fixture' ? parsed.appServerFixtureBoundary.helperSha256 :
              parsed.appServerMetadataPipeBoundary?.helperSha256;
            if (!advertised || Object.keys(advertised).length !== helperNames.length ||
                Object.entries(helperHashes).some(([name, digest]) => advertised[name] !== digest)) throw new Error('HELPER_IDENTITY');
            if (launcher === 'systemd') {
              if (!ownership || !parsed.systemdFixtureBoundary) throw new Error('RESOURCE_RECEIPT_MISSING');
              resources = parsed.systemdFixtureBoundary;
              const leaf = `/user.slice/user-${resources.uid}.slice/user@${resources.uid}.service/app.slice/${resources.unit}`;
              const control = resources.control;
              if (resources.uid !== parsed.sandbox.uid || control.managerUid !== resources.uid ||
                control.managerSocket.path !== `/run/user/${resources.uid}/systemd/private` ||
                control.managerSocket.components.some((item, index) => (item.mode & 0xf000) !== (index === 4 ? 0xc000 : 0x4000)) ||
                control.managerSocket.components[4].uid !== resources.uid || resources.relaySha256 !== resourceHashes!.relay || resources.probeSha256 !== resourceHashes!.probe ||
                resources.leaf !== '/sys/fs/cgroup' + leaf || control.unitMainCgroup !== leaf ||
                resources.unit !== ownership.unit || resources.uid !== ownership.uid || control.driverPid !== ownership.driverPid ||
                [control.driverCgroup, control.managerCgroup].some(path => !path.startsWith('/') || path === leaf || path.startsWith(leaf + '/')) ||
                new Set([control.driverPid, control.managerPid, control.unitMainPid]).size !== 3) throw new Error('RESOURCE_IDENTITY');
            } else if (parsed.systemdFixtureBoundary) throw new Error('UNEXPECTED_RESOURCE_RECEIPT');
            ready = true; evidence.ready = parsed;
            if (!stopped) {
              void write({ type: 'start', mode: selectedMode, ...(profile === 'fixture' ? { scenario } : {}), helperSha256: helperHashes }).catch(() => fail('START_WRITE_FAILED'));
              heartbeat = setInterval(() => { if (!child.stdin.writableNeedDrain) void write({ type: 'heartbeat' }).catch(() => fail('HEARTBEAT_FAILED')); }, 500);
            }
          } else if (frame.type === 'started') {
            z.object({ version: z.literal(1), type: z.literal('started'), mode: z.literal(selectedMode), pid: count.min(2) }).strict().parse(frame);
            if (started) throw new Error('DUPLICATE_START'); started = true; resolveStart();
          } else if (frame.type === 'fixture_input_ack') {
            z.object({ version: z.literal(1), type: z.literal('fixture_input_ack'), seq: count.positive() }).strict().parse(frame);
            if (stopped && cancelledAck === frame.seq) { cancelledAck = null; continue; }
            if (!ack || frame.seq !== ack.seq) throw new Error('INPUT_ACK_ORDER');
            const accepted = ack; ack = null; accepted.resolve();
          } else if (frame.type === 'child_output') {
            z.object({ version: z.literal(1), type: z.literal('child_output'), stream: z.enum(['stdout', 'stderr']),
              encoding: z.literal('base64'), data: z.string().max(8192) }).strict().parse(frame);
            if (!started) throw new Error('OUTPUT_BEFORE_START');
            const bytes = Buffer.from(frame.data, 'base64');
            if (bytes.toString('base64') !== frame.data || bytes.length > 4096) throw new Error('INVALID_BASE64');
            evidence.outputBytes += bytes.length; digest.update(bytes);
            if (evidence.outputBytes > 8388608 + 4096) throw new Error('EXCESS_CROSSING_OUTPUT');
            // Ack and child output may share one OS read. Allow the send promise
            // and caller's delivered-id bookkeeping to settle before output.
            pendingOutputs++;
            setImmediate(() => {
              try { callbacks.onOutput(frame.stream, bytes); } catch { fail('OUTPUT_CALLBACK_FAILED'); }
              finally { pendingOutputs--; if (finishRequested && pendingOutputs === 0) finish(); }
            });
            if (evidence.outputBytes > 8388608) close();
          } else if (frame.type === 'terminal') {
            terminal = terminalSchema.parse(frame); evidence.terminal = terminal;
            if (launcher === 'systemd') {
              if (!resources || !terminal.systemdFixtureBoundary) throw new Error('RESOURCE_CLEANUP_MISSING');
              const { preStartReadback: _readback, cleanup: _cleanup, relayErrors: _errors, ...identity } = terminal.systemdFixtureBoundary;
              if (JSON.stringify(identity) !== JSON.stringify(resources)) throw new Error('RESOURCE_TERMINAL_IDENTITY');
            } else if (terminal.systemdFixtureBoundary) throw new Error('UNEXPECTED_RESOURCE_RECEIPT');
            if (terminal.mode !== selectedMode || terminal.outputComplete !== (terminal.streamEOF.stdout && terminal.streamEOF.stderr)) throw new Error('TERMINAL_IDENTITY');
            if (!terminal.outputLimitExceeded && (!terminal.outputComplete || terminal.outputBytes !== evidence.outputBytes || terminal.observedOutputSha256 !== digest.digest('hex'))) throw new Error('OUTPUT_EVIDENCE');
            if (terminal.outputLimitExceeded && (terminal.outputBytes <= 8388608 || terminal.outputBytes < evidence.outputBytes)) throw new Error('OUTPUT_LIMIT_EVIDENCE');
            clearInterval(heartbeat); clearTimeout(closeTimer); child.stdin.end();
            closeTimer = setTimeout(() => { evidence.error ??= 'LOCAL_CLOSE_TIMEOUT'; child.kill('SIGKILL');
              closeTimer = setTimeout(finish, 2000); }, 2000);
          } else if (frame.type === 'failure') {
            z.object({ version: z.literal(1), type: z.literal('failure'), error: z.string().max(1024) }).strict().parse(frame);
            throw new Error('RELAY_FAILURE:' + frame.error);
          } else throw new Error('UNEXPECTED_FRAME');
        } catch (error) { fail(error instanceof Error ? error.message : 'INVALID_FRAME'); return; }
      }
      if (Buffer.byteLength(partial) > 65536) fail('FRAME_LIMIT');
    });
    child.on('close', (code, childSignal) => {
      evidence.localClose = { code, signal: childSignal };
      if (partial.length || decoder.end()) { invalid = true; evidence.error ??= 'TRUNCATED_FRAME'; }
      if (!terminal) evidence.error ??= 'TERMINAL_MISSING';
      finish();
    });
    return { cleanup, close, send(frame) {
      let bytes: Buffer;
      try { bytes = Buffer.from(JSON.stringify(frame) + '\n'); } catch { return Promise.reject(new Error('INVALID_INPUT')); }
      inputBytes += bytes.length;
      if (inputBytes > 2 * 1024 * 1024) { close(); return Promise.reject(new Error('INPUT_LIMIT')); }
      const operation = writes.then(async () => {
        await start;
        for (let offset = 0; offset < bytes.length; offset += 2048) {
          if (stopped || sealed) throw new Error('FIXTURE_CLOSED');
          const seq = ++sequence;
          const accepted = new Promise<void>((resolve, reject) => { ack = { seq, resolve, reject }; });
          void accepted.catch(() => undefined);
          await write({ type: 'fixture_input', seq, data: bytes.subarray(offset, offset + 2048).toString('base64') });
          await accepted;
        }
      });
      writes = operation.catch(() => undefined); return operation;
    } };
  };
}
