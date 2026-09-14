/** Fixed credential-free CLI capsule transport. Never a production Command,
 * login interface or inference provider. Child output is opaque binary data. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

const modes = ['version', 'private-sentinel', 'sleep', 'setsid', 'flood', 'partial-setup', 'stopped-cli', 'paced-output'] as const;
export type CliProbeMode = typeof modes[number];
const int = z.number().int().safe();
const stoppedFixture = z.object({ kind: z.literal('owned-cli-stopped'), pid: int.min(2), executable: z.literal('/usr/bin/codex'),
  state: z.literal('T'), signal: z.literal('SIGSTOP'), sinceStartMs: int.nonnegative() }).strict();
const checks = z.object({ capabilitiesDropped: z.boolean(), noNewPrivileges: z.boolean(), runtimeWriteDenied: z.boolean(),
  workWriteExpected: z.boolean(), networkDenied: z.boolean(), protectedOutputNotExposed: z.boolean(),
  publicControlReadable: z.boolean(), privateReadExpected: z.boolean() }).strict();
const terminalSchema = z.object({ version: z.literal(1), type: z.literal('terminal'), reason: z.string().nullable(),
  mode: z.enum(modes).nullable(), exitCode: int.nullable(), elapsedMs: int.nonnegative(),
  outputBytes: int.nonnegative(), observedOutputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputComplete: z.boolean(), streamEOF: z.object({ stdout: z.boolean(), stderr: z.boolean() }).strict(),
  outputLimitExceeded: z.boolean(), registryOverflow: z.boolean(),
  cleanup: z.object({ verified: z.boolean(), namespaceEmpty: z.boolean(), observedPidfds: int.nonnegative().max(1_000_000),
    allObservedPidfdsESRCH: z.boolean(), killSent: z.boolean(),
    signalFailures: z.array(z.object({ pid: int.min(2), errno: int }).strict()).max(32) }).strict(),
  privateChecks: checks.nullable(), credentialFilesRead: z.literal(false), modelCalls: z.literal(0), productionReady: z.literal(false),
  productionAuth: z.literal('NOT_RUN'), productionNetwork: z.literal('NOT_RUN'), productionCleanup: z.literal('NOT_RUN'),
  fixture: stoppedFixture.nullable().optional(), terminationElapsedMs: int.nonnegative().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cleanup.verified && (!value.cleanup.namespaceEmpty || !value.cleanup.allObservedPidfdsESRCH ||
    value.cleanup.signalFailures.length > 0 || value.registryOverflow))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent cleanup evidence' });
  if (value.outputComplete !== (value.streamEOF.stdout && value.streamEOF.stderr) && value.mode !== null)
    ctx.addIssue({ code: 'custom', message: 'Inconsistent output completeness' });
});
const readySchema = z.object({ version: z.literal(1), type: z.literal('ready'),
  trustedIngressBoundary: z.object({ helperSha256: z.object({
    'subscription-trusted-ingress-child.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-trusted-ingress-worker-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-trusted-control-boundary-parent.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-trusted-control-boundary-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-gate.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-trampoline.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-worker-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-appserver-noenv.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-text-model-catalog.json': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  trustedIngressFd: z.object({ fd: z.literal(198),
    socket: z.object({ dev: int.nonnegative(), ino: int.nonnegative().min(1), type: z.literal(49152), family: z.literal(1), socketType: z.literal(1) }).strict(),
    bootstrapInheritance: z.literal('trusted-setup-only'), preservedAcrossPivot: z.literal(true),
  }).strict().optional(),
  trustedControlBoundary: z.object({ helperSha256: z.object({
    'subscription-trusted-control-boundary-parent.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-trusted-control-boundary-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-gate.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-trampoline.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-worker-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-appserver-noenv.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-text-model-catalog.json': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  execEnvironmentMetadataBoundary: z.object({ helperSha256: z.object({
    'subscription-exec-environment-metadata-parent.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-gate.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-trampoline.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-worker-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-appserver-noenv.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-text-model-catalog.json': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  execServerWorkerBoundary: z.object({ helperSha256: z.object({
    'subscription-exec-server-worker-gate.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-server-worker-trampoline.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-exec-worker-probe.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-appserver-noenv.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-text-model-catalog.json': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  appServerMetadataPipeBoundary: z.object({ helperSha256: z.object({
    'subscription-appserver-metadata-pipe-child.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-appserver-noenv.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-text-model-catalog.json': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  appServerFixtureBoundary: z.object({ helperSha256: z.object({
    'subscription-appserver-fixture-child.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  utsBoundary: z.object({ hostname: z.literal('reality-compiler-probe'),
    namespace: z.string().regex(/^uts:\[[1-9][0-9]*\]$/) }).strict().optional(),
  appServerBoundary: z.object({ helperSha256: z.object({
    'subscription-appserver-noenv.py': z.string().regex(/^[a-f0-9]{64}$/),
    'subscription-text-model-catalog.json': z.string().regex(/^[a-f0-9]{64}$/),
  }).strict() }).strict().optional(),
  workerBoundary: z.object({
    helperSha256: z.object({ 'subscription-worker-lockdown.py': z.string().regex(/^[a-f0-9]{64}$/),
      'subscription-worker-boundary-child.py': z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    namespace: z.string().regex(/^pid:\[[1-9][0-9]*\]$/), mountNamespace: z.string().regex(/^mnt:\[[1-9][0-9]*\]$/),
    output: z.object({ dev: int.nonnegative(), ino: int.positive(), type: int.positive() }).strict(),
    control: z.object({ dev: int.nonnegative(), ino: int.positive(), type: int.positive() }).strict(),
  }).strict().optional(),
  sandbox: z.object({ pidNamespaceInit: z.literal(true), hostHomeMounted: z.literal(false), hostMntMounted: z.literal(false),
    networkInterfaces: z.tuple([z.literal('lo')]), uid: int.nonnegative(), gid: int.nonnegative(),
    ttyIsNullDevice: z.literal(true), runtimeWriteDenied: z.literal(true), parentNondumpable: z.literal(true) }).strict(),
  binarySha256: z.literal('a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'),
  bwrapSha256: z.literal('77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'),
  limits: z.object({ jobMs: z.literal(180000), commandMs: z.literal(200000), termGraceMs: z.literal(5000),
    maxOutputBytes: z.literal(8388608), commandBudgetEnforcedHere: z.literal(false), aggregateResourcesEnforced: z.literal(false) }).strict(),
}).strict();
const frameSchema = z.union([readySchema, terminalSchema,
  stoppedFixture.extend({ version: z.literal(1), type: z.literal('fixture_ready'), mode: z.literal('stopped-cli') }).strict(),
  z.object({ version: z.literal(1), type: z.literal('started'), mode: z.enum(modes), pid: int.min(2) }).strict(),
  z.object({ version: z.literal(1), type: z.literal('child_output'), stream: z.enum(['stdout', 'stderr']),
    encoding: z.literal('base64'), data: z.string().max(8192).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ version: z.literal(1), type: z.literal('failure'), error: z.string().max(1024) }).strict(),
]);
export type CliProbeTerminal = z.infer<typeof terminalSchema>;
export interface CliProbeResult {
  outcome: 'completed' | 'cancelled' | 'failed' | 'not-started'; error: string | null;
  cleanup: 'verified' | 'unverified' | 'unknown' | 'not-started'; terminal: CliProbeTerminal | null;
  localClose: { code: number | null; signal: string | null } | null;
  outputBytes: number; stdout: string; stderr: string;
  modelCalls: 0; credentialFilesRead: false; productionReady: false;
}

/** The fixed launcher sets an empty Linux env before any capsule program runs.
 * No paths, argv, environment or budgets are accepted from data callers. */
export async function runCliSupervisorProbe(options: { mode: CliProbeMode; signal?: AbortSignal;
  observe?: (frame: unknown) => void }): Promise<CliProbeResult> {
  options = { ...options };
  if (!modes.includes(options.mode)) throw new Error('INVALID_CLI_PROBE_MODE');
  const result: CliProbeResult = { outcome: 'failed', error: null, cleanup: 'unknown', terminal: null, localClose: null,
    outputBytes: 0, stdout: '', stderr: '', modelCalls: 0, credentialFilesRead: false, productionReady: false };
  if (options.signal?.aborted) return { ...result, outcome: 'not-started', cleanup: 'not-started' };
  return new Promise(resolve => {
    const child = spawn('C:\\Windows\\System32\\wsl.exe', ['--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i',
      'PATH=/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '200s',
      '/usr/bin/unshare', '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--uts', '--pid', '--fork',
      '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false, started = false, fixtureReady = false, earlyOutput = false, invalid = false, settled = false, stopping = false, pending = '', wireBytes = 0;
    const decoder = new StringDecoder('utf8');
    const outputHash = createHash('sha256');
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => { result.error ??= 'COMMAND_DEADLINE'; stop(); }, 200000);
    const send = (value: unknown, heartbeatOnly = false) => {
      // Node queues reliable start/cancel frames even under backpressure. There
      // are at most three such tiny frames per run; periodic heartbeats are
      // skipped while draining so they cannot grow the control queue.
      if (!child.stdin.destroyed && !child.stdin.writableEnded && (!heartbeatOnly || !child.stdin.writableNeedDrain))
        child.stdin.write(JSON.stringify(value) + '\n');
    };
    function finish() {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(stopTimer); clearInterval(heartbeat);
      options.signal?.removeEventListener('abort', abort);
      result.stdout += decoders.stdout.end(); result.stderr += decoders.stderr.end();
      if (result.terminal && !invalid) result.cleanup = result.terminal.cleanup.verified ? 'verified' : 'unverified';
      const terminal = result.terminal;
      if (terminal?.outputLimitExceeded) result.error ??= 'OUTPUT_LIMIT';
      if (!result.error && result.localClose?.code === 0 && result.cleanup === 'verified' && terminal) {
        if (started && !earlyOutput && terminal.reason === 'EXITED' && terminal.exitCode === 0 && terminal.outputComplete && !terminal.outputLimitExceeded) {
          if (options.mode === 'private-sentinel' && (!terminal.privateChecks || Object.keys(terminal.privateChecks).length !== 8 ||
            !Object.values(terminal.privateChecks).every(Boolean))) result.error = 'PRIVATE_CHECK_FAILED';
          else result.outcome = 'completed';
        } else if (options.signal?.aborted && terminal.reason === 'CANCELLED') result.outcome = 'cancelled';
        else result.error = 'CLI_PROBE_FAILED';
      }
      if (result.outcome === 'failed') result.error ??= 'CLI_PROBE_FAILED';
      resolve(result);
    }
    function killWrapper() {
      child.kill('SIGKILL');
      stopTimer = setTimeout(() => { result.error ??= 'LOCAL_CLOSE_TIMEOUT'; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(); }, 2000);
    }
    function stop() {
      if (stopping || settled || result.terminal) return;
      stopping = true; clearInterval(heartbeat); send({ type: 'cancel' });
      // Preserve the Linux process while it performs TERM grace and owned reap.
      stopTimer = setTimeout(() => { result.error ??= 'TERMINAL_TIMEOUT'; killWrapper(); }, 10000);
    }
    function abort() { stop(); }
    function fail(code: string) { invalid = true; result.error ??= code; stop(); }
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { result.error ??= 'SPAWN_FAILED'; });
    child.stdin.on('error', () => { result.error ??= 'CONTROL_PIPE_FAILED'; });
    child.stderr.on('data', (chunk: Buffer) => {
      // Wrapper diagnostics are not model output or cleanup acknowledgement.
      if (chunk.length) fail('WRAPPER_DIAGNOSTIC');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (invalid || settled) return;
      wireBytes += chunk.length;
      if (wireBytes > 16 * 1024 * 1024) { fail('WIRE_LIMIT'); return; }
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > 65536) { fail('FRAME_LIMIT'); return; }
        let frame: z.infer<typeof frameSchema>;
        try { frame = frameSchema.parse(JSON.parse(line)); } catch { fail('INVALID_FRAME'); return; }
        if (result.terminal || (!ready && frame.type !== 'ready')) { fail('INVALID_FRAME_ORDER'); return; }
        if (frame.type === 'ready') {
          if (ready) { fail('DUPLICATE_READY'); return; } ready = true;
          if (options.signal?.aborted || stopping) send({ type: 'cancel' });
          else { send({ type: 'start', mode: options.mode }); heartbeat = setInterval(() => send({ type: 'heartbeat' }, true), 500); }
        } else if (frame.type === 'started') {
          if (started || frame.mode !== options.mode) { fail('INVALID_START'); return; } started = true;
        } else if (frame.type === 'fixture_ready') {
          if (!started || fixtureReady || options.mode !== 'stopped-cli') { fail('INVALID_FIXTURE_READY'); return; }
          fixtureReady = true;
        } else if (frame.type === 'child_output') {
          earlyOutput ||= !started;
          const bytes = Buffer.from(frame.data, 'base64'); result.outputBytes += bytes.length;
          if (result.outputBytes > 8388608) { fail('OUTPUT_LIMIT'); return; }
          outputHash.update(bytes); result[frame.stream] += decoders[frame.stream].write(bytes);
        } else if (frame.type === 'failure') result.error ??= 'SUPERVISOR_FAILURE';
        else {
          if ((frame.mode !== null && frame.mode !== options.mode) || (started && frame.mode === null)) { fail('TERMINAL_MODE_MISMATCH'); return; }
          if (frame.outputComplete && !frame.outputLimitExceeded && (frame.outputBytes !== result.outputBytes ||
            frame.observedOutputSha256 !== outputHash.digest('hex'))) { fail('OUTPUT_EVIDENCE_MISMATCH'); return; }
          result.terminal = frame; clearInterval(heartbeat); clearTimeout(stopTimer); child.stdin.end();
          stopTimer = setTimeout(() => { result.error ??= 'LOCAL_CLOSE_TIMEOUT'; killWrapper(); }, 2000);
        }
        try { options.observe?.(structuredClone(frame)); } catch { fail('OBSERVER_FAILED'); return; }
      }
      if (Buffer.byteLength(pending) > 65536) fail('FRAME_LIMIT');
    });
    child.on('close', (code, signal) => {
      result.localClose = { code, signal };
      if (pending.length || decoder.end()) { invalid = true; result.error ??= 'TRUNCATED_FRAME'; }
      if (!result.terminal) result.error ??= 'TERMINAL_MISSING';
      finish();
    });
    if (options.signal?.aborted) abort();
  });
}
