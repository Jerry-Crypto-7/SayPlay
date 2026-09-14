/** Fixed credential-free actual app-server metadata pipes. Never an inference launcher. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { GenerationCleanup, GenerationTransportFactory } from './subscription-appserver-generation';
import { createSystemdAppServerMetadataPipeTransport } from './subscription-appserver-fixture-transport';

export const METADATA_SYSTEM = 'Metadata transport validation only; no inference.';
const MODE = 'appserver-metadata-pipe';
const helperNames = ['subscription-appserver-metadata-pipe-child.py', 'subscription-appserver-noenv.py',
  'subscription-worker-lockdown.py', 'subscription-text-model-catalog.json'] as const;
const count = z.number().int().safe().nonnegative(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const helpersSchema = z.object({ 'subscription-appserver-metadata-pipe-child.py': hash, 'subscription-appserver-noenv.py': hash,
  'subscription-worker-lockdown.py': hash, 'subscription-text-model-catalog.json': hash }).strict();
const readySchema = z.object({ version: z.literal(1), type: z.literal('ready'),
  utsBoundary: z.object({ hostname: z.literal('reality-compiler-probe'), namespace: z.string().regex(/^uts:\[[1-9][0-9]*\]$/) }).strict(),
  appServerMetadataPipeBoundary: z.object({ helperSha256: helpersSchema }).strict(),
  sandbox: z.object({ pidNamespaceInit: z.literal(true), hostHomeMounted: z.literal(false), hostMntMounted: z.literal(false),
    networkInterfaces: z.tuple([z.literal('lo')]), uid: count, gid: count, ttyIsNullDevice: z.literal(true),
    runtimeWriteDenied: z.literal(true), parentNondumpable: z.literal(true) }).strict(),
  binarySha256: z.literal('a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'),
  bwrapSha256: z.literal('77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'),
  limits: z.object({ jobMs: z.literal(180000), commandMs: z.literal(200000), termGraceMs: z.literal(5000),
    maxOutputBytes: z.literal(8388608), commandBudgetEnforcedHere: z.literal(false), aggregateResourcesEnforced: z.literal(false) }).strict(),
  workerBoundary: z.unknown().optional(), appServerBoundary: z.unknown().optional(), appServerFixtureBoundary: z.unknown().optional(),
}).strict();
const terminalSchema = z.object({ version: z.literal(1), type: z.literal('terminal'), reason: z.string().nullable(),
  mode: z.literal(MODE), exitCode: z.number().int().nullable(), elapsedMs: count, outputBytes: count,
  observedOutputSha256: hash, outputComplete: z.boolean(), streamEOF: z.object({ stdout: z.boolean(), stderr: z.boolean() }).strict(),
  outputLimitExceeded: z.boolean(), registryOverflow: z.boolean(),
  cleanup: z.object({ verified: z.boolean(), namespaceEmpty: z.boolean(), observedPidfds: count,
    allObservedPidfdsESRCH: z.boolean(), killSent: z.boolean(), signalFailures: z.array(z.object({ pid: count, errno: z.number().int() }).strict()).max(32) }).strict(),
  privateChecks: z.null(), credentialFilesRead: z.literal(false), modelCalls: z.literal(0), productionReady: z.literal(false),
  productionAuth: z.literal('NOT_RUN'), productionNetwork: z.literal('NOT_RUN'), productionCleanup: z.literal('NOT_RUN'),
  fixture: z.null().optional(), terminationElapsedMs: count.nullable().optional(),
}).strict();

/** Fresh literal objects; callers cannot alter a later admission template. */
export function metadataRequests(): Record<string, unknown>[] {
  return [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'reality_compiler_generation', version: '1' }, capabilities: { experimentalApi: true } } },
    { method: 'initialized', params: {} },
    { id: 2, method: 'thread/start', params: {
      model: 'gpt-5.6-sol', modelProvider: 'openai', allowProviderModelFallback: false, cwd: '/work', approvalPolicy: 'never',
      sandbox: 'read-only', ephemeral: true, environments: [], dynamicTools: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [],
      developerInstructions: METADATA_SYSTEM,
      config: { model_reasoning_effort: 'low', model_catalog_json: '/usr/bin/text-model-catalog.json',
        'agents.enabled': false, 'features.shell_tool': false, 'features.apps': false, 'features.multi_agent': false,
        'features.multi_agent_v2': false, 'features.image_generation': false, 'features.goals': false, 'features.memories': false,
        'features.plugins': false, 'features.code_mode': false, 'features.code_mode_only': false, 'features.deferred_executor': false,
        'features.token_budget': false, 'features.current_time_reminder': false, 'features.skill_search': false,
        'tools.experimental_request_user_input.enabled': false, 'orchestrator.skills.enabled': false, 'orchestrator.mcp.enabled': false,
        'skills.include_instructions': false, web_search: 'disabled' },
    } },
    { id: 3, method: 'model/list', params: { includeHidden: true } },
  ];
}

export interface MetadataTransportEvidence {
  kind: 'ACTUAL_CLI_METADATA_ONLY'; actualModelCalls: 0; credentialFilesRead: false; productionReady: false;
  aggregateResourcesValidated: boolean; error: string | null; ready: unknown; terminal: unknown;
  localClose: { code: number | null; signal: string | null } | null; outputBytes: number;
  admittedMethods: string[]; refusedMethod: string | null;
  inputAckScope: 'supervisor-to-bridge-write-only';
  systemdOwnership?: unknown; systemdFailure?: unknown;
}

/** The same exact admission and ownership fence wraps both explicit launchers. */
function guardedMetadataFactory(makePipe: (observe: (value: MetadataTransportEvidence) => void) => GenerationTransportFactory,
  observe?: (value: MetadataTransportEvidence) => void): GenerationTransportFactory {
  let busy = false, blocked = false;
  return (callbacks, signal) => {
    if (blocked || busy) throw new Error(blocked ? 'PRIOR_TERMINATION_UNKNOWN' : 'METADATA_TRANSPORT_BUSY');
    if (signal.aborted) return { send: async () => { throw new Error('METADATA_CLOSED'); }, close() {},
      cleanup: Promise.resolve({ local: 'confirmed', remote: 'confirmed' }) };
    let requestIndex = 0, refusedMethod: string | null = null;
    const admittedMethods: string[] = [];
    busy = true;
    try {
      const pipe = makePipe(value => {
        try { observe?.(structuredClone({ ...value, admittedMethods, refusedMethod })); } catch { /* Evidence cannot grant process credit. */ }
      })(callbacks, signal);
      const cleanup = pipe.cleanup.then(value => {
        busy = false; blocked = value.local === 'unknown' || value.remote === 'unknown'; return value;
      }, () => { busy = false; blocked = true; return { local: 'unknown', remote: 'unknown' } as GenerationCleanup; });
      return { cleanup, close: () => pipe.close(), send(frame) {
        const expected = metadataRequests()[requestIndex];
        if (!expected || !isDeepStrictEqual(frame, expected)) {
          refusedMethod = typeof frame?.method === 'string' ? frame.method.slice(0, 128) : '<invalid>';
          pipe.close(); return Promise.reject(new Error('METADATA_RPC_NOT_ALLOWED'));
        }
        requestIndex++; admittedMethods.push(expected.method as string);
        // Snapshot fixed literal template before asynchronous raw transport work.
        return pipe.send(structuredClone(expected));
      } };
    } catch (error) { busy = false; blocked = true; throw error; }
  };
}

export function createAppServerMetadataTransport(observe?: (value: MetadataTransportEvidence) => void): GenerationTransportFactory {
  return guardedMetadataFactory(createBasicMetadataPipeTransport, observe);
}

/** Explicit resource-bound metadata variant; the shared broker still owns OS admission and cleanup. */
export function createSystemdAppServerMetadataTransport(observe?: (value: MetadataTransportEvidence) => void): GenerationTransportFactory {
  return guardedMetadataFactory(listener => createSystemdAppServerMetadataPipeTransport(value => listener({ ...value,
    kind: 'ACTUAL_CLI_METADATA_ONLY', admittedMethods: [], refusedMethod: null, inputAckScope: 'supervisor-to-bridge-write-only' })), observe);
}

function createBasicMetadataPipeTransport(observe?: (value: MetadataTransportEvidence) => void): GenerationTransportFactory {
  return (callbacks, signal) => {
    const helperSha256 = Object.fromEntries(helperNames.map(name => [name, createHash('sha256').update(readFileSync(new URL('./' + name, import.meta.url))).digest('hex')]));
    const child = spawn('C:\\Windows\\System32\\wsl.exe', ['--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i',
      'PATH=/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '200s', '/usr/bin/unshare',
      '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--uts', '--pid', '--fork',
      '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const evidence: MetadataTransportEvidence = { kind: 'ACTUAL_CLI_METADATA_ONLY', actualModelCalls: 0, credentialFilesRead: false,
      productionReady: false, aggregateResourcesValidated: false, error: null, ready: null, terminal: null, localClose: null,
      outputBytes: 0, admittedMethods: [], refusedMethod: null, inputAckScope: 'supervisor-to-bridge-write-only' };
    let resolveCleanup!: (value: GenerationCleanup) => void;
    const cleanup = new Promise<GenerationCleanup>(resolve => { resolveCleanup = resolve; });
    let ready = false, started = false, stopped = false, sealed = false, invalid = false, finishing = false;
    let pendingOutputs = 0, wireBytes = 0, partial = '', sequence = 0, inputBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true }), digest = createHash('sha256');
    let terminal: z.infer<typeof terminalSchema> | null = null;
    let resolveStart!: () => void, rejectStart!: (error: Error) => void;
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; }); void start.catch(() => undefined);
    let ack: { seq: number; resolve(): void; reject(error: Error): void } | null = null, cancelledAck: number | null = null;
    let writes = Promise.resolve();
    let heartbeat: ReturnType<typeof setInterval> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => fail('COMMAND_DEADLINE'), 200000);
    const write = (frame: unknown) => new Promise<void>((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('CONTROL_CLOSED')); return; }
      child.stdin.write(JSON.stringify(frame) + '\n', error => error ? reject(error) : resolve());
    });
    function finish() {
      if (sealed) return; finishing = true; if (pendingOutputs) return; sealed = true;
      clearTimeout(deadline); clearTimeout(closeTimer); clearInterval(heartbeat); signal.removeEventListener('abort', close);
      rejectStart(new Error('METADATA_CLOSED')); ack?.reject(new Error('METADATA_CLOSED')); ack = null;
      try { callbacks.onOutputAccounting?.({ observedBytes: !invalid && ready && started && terminal ? terminal.outputBytes : null }); }
      catch { invalid = true; evidence.error ??= 'ACCOUNTING_CALLBACK_FAILED'; }
      const verified = !invalid && ready && started && terminal?.cleanup.verified && terminal.cleanup.namespaceEmpty &&
        terminal.cleanup.allObservedPidfdsESRCH && terminal.cleanup.observedPidfds > 0 && !terminal.registryOverflow && !terminal.cleanup.signalFailures.length;
      const value: GenerationCleanup = { local: evidence.localClose ? 'confirmed' : 'unknown', remote: verified ? 'confirmed' : 'unknown' };
      resolveCleanup(value); try { observe?.(structuredClone(evidence)); } catch { /* No process credit from observer. */ }
    }
    function close() {
      if (stopped || sealed) return; stopped = true; clearInterval(heartbeat);
      cancelledAck = ack?.seq ?? null; rejectStart(new Error('METADATA_CLOSED')); ack?.reject(new Error('METADATA_CLOSED')); ack = null;
      void write({ type: 'cancel' }).catch(() => undefined);
      closeTimer = setTimeout(() => { evidence.error ??= 'TERMINAL_TIMEOUT'; child.kill('SIGKILL');
        closeTimer = setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(); }, 2000); }, 10000);
    }
    function fail(error: string) { invalid = true; evidence.error ??= error; close(); }
    signal.addEventListener('abort', close, { once: true });
    child.on('error', () => fail('SPAWN_FAILED')); child.stdin.on('error', () => fail('CONTROL_PIPE_FAILED'));
    child.stderr.on('data', () => fail('WRAPPER_DIAGNOSTIC'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (sealed || invalid) return;
      wireBytes += chunk.length; if (wireBytes > 16 * 1024 * 1024) { fail('WIRE_LIMIT'); return; }
      try {
        partial += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
          if (Buffer.byteLength(line) > 65536) throw new Error('FRAME_LIMIT');
          const frame = JSON.parse(line);
          if (!frame || frame.version !== 1 || terminal || (!ready && frame.type !== 'ready')) throw new Error('FRAME_ORDER');
          if (frame.type === 'ready') {
            if (ready) throw new Error('DUPLICATE_READY');
            const parsed = readySchema.parse(frame);
            if (!isDeepStrictEqual(parsed.appServerMetadataPipeBoundary.helperSha256, helperSha256)) throw new Error('HELPER_IDENTITY');
            evidence.ready = parsed; ready = true;
            if (!stopped) { void write({ type: 'start', mode: MODE, helperSha256 }).catch(() => fail('START_WRITE_FAILED'));
              heartbeat = setInterval(() => { if (!child.stdin.writableNeedDrain) void write({ type: 'heartbeat' }).catch(() => fail('HEARTBEAT_FAILED')); }, 500); }
          } else if (frame.type === 'started') {
            z.object({ version: z.literal(1), type: z.literal('started'), mode: z.literal(MODE), pid: count.min(2) }).strict().parse(frame);
            if (started) throw new Error('DUPLICATE_START'); started = true; resolveStart();
          } else if (frame.type === 'fixture_input_ack') {
            z.object({ version: z.literal(1), type: z.literal('fixture_input_ack'), seq: count.positive() }).strict().parse(frame);
            if (stopped && cancelledAck === frame.seq) { cancelledAck = null; continue; }
            if (!ack || frame.seq !== ack.seq) throw new Error('INPUT_ACK_ORDER'); const current = ack; ack = null; current.resolve();
          } else if (frame.type === 'child_output') {
            z.object({ version: z.literal(1), type: z.literal('child_output'), stream: z.enum(['stdout', 'stderr']), encoding: z.literal('base64'), data: z.string().max(8192) }).strict().parse(frame);
            if (!started) throw new Error('OUTPUT_BEFORE_START');
            const bytes = Buffer.from(frame.data, 'base64');
            if (bytes.toString('base64') !== frame.data || bytes.length > 4096) throw new Error('INVALID_BASE64');
            evidence.outputBytes += bytes.length; digest.update(bytes);
            if (evidence.outputBytes > 8388608 + 4096) throw new Error('EXCESS_CROSSING_OUTPUT');
            pendingOutputs++; setImmediate(() => { try { callbacks.onOutput(frame.stream, bytes); } catch { fail('OUTPUT_CALLBACK_FAILED'); }
              finally { pendingOutputs--; if (finishing) finish(); } });
            if (evidence.outputBytes > 8388608) close();
          } else if (frame.type === 'terminal') {
            terminal = terminalSchema.parse(frame); evidence.terminal = terminal;
            if (terminal.outputComplete !== (terminal.streamEOF.stdout && terminal.streamEOF.stderr)) throw new Error('TERMINAL_IDENTITY');
            if (!terminal.outputLimitExceeded && (!terminal.outputComplete || terminal.outputBytes !== evidence.outputBytes || terminal.observedOutputSha256 !== digest.digest('hex'))) throw new Error('OUTPUT_EVIDENCE');
            if (terminal.outputLimitExceeded && (terminal.outputBytes <= 8388608 || terminal.outputBytes < evidence.outputBytes)) throw new Error('OUTPUT_LIMIT_EVIDENCE');
            clearInterval(heartbeat); clearTimeout(closeTimer); child.stdin.end();
            closeTimer = setTimeout(() => { evidence.error ??= 'LOCAL_CLOSE_TIMEOUT'; child.kill('SIGKILL'); closeTimer = setTimeout(finish, 2000); }, 2000);
          } else if (frame.type === 'failure') {
            z.object({ version: z.literal(1), type: z.literal('failure'), error: z.string().max(1024) }).strict().parse(frame);
            throw new Error('RELAY_FAILURE:' + frame.error);
          } else throw new Error('UNEXPECTED_FRAME');
        }
        if (Buffer.byteLength(partial) > 65536) throw new Error('FRAME_LIMIT');
      } catch (error) { fail(error instanceof Error ? error.message : 'INVALID_FRAME'); }
    });
    child.on('close', (code, childSignal) => {
      evidence.localClose = { code, signal: childSignal };
      try { if (partial.length || decoder.decode()) throw new Error('TRUNCATED_FRAME'); } catch { invalid = true; evidence.error ??= 'TRUNCATED_FRAME'; }
      if (!terminal) evidence.error ??= 'TERMINAL_MISSING'; finish();
    });
    return { cleanup, close, send(frame) {
      const bytes = Buffer.from(JSON.stringify(frame) + '\n'); inputBytes += bytes.length;
      if (inputBytes > 2 * 1024 * 1024) { close(); return Promise.reject(new Error('INPUT_LIMIT')); }
      const operation = writes.then(async () => {
        await start;
        for (let offset = 0; offset < bytes.length; offset += 2048) {
          if (stopped || sealed) throw new Error('METADATA_CLOSED');
          const seq = ++sequence;
          const accepted = new Promise<void>((resolve, reject) => { ack = { seq, resolve, reject }; }); void accepted.catch(() => undefined);
          await write({ type: 'fixture_input', seq, data: bytes.subarray(offset, offset + 2048).toString('base64') }); await accepted;
        }
      });
      writes = operation.catch(() => undefined); return operation;
    } };
  };
}
