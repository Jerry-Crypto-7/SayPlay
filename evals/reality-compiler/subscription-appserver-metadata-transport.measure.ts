/** Explicit no-turn actual CLI metadata/cleanup integration, never generation success. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createAppServerGenerationAdapter, type LateGenerationEvidence, LINUX_SANDBOX_ADVISORY_SUMMARY } from '../../scripts/subscription-appserver-generation';
import { createAppServerMetadataTransport, METADATA_SYSTEM, type MetadataTransportEvidence } from '../../scripts/subscription-appserver-metadata-transport';

it.skipIf(process.env.RC_APPSERVER_METADATA_PIPE_SMOKE !== '1')('observes actual metadata then refuses turn and verifies owned cleanup', async () => {
  const directory = resolve('scratch', `session8-appserver-metadata-pipe-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const paths = ['scripts/subscription-exec-server-worker-gate.py', 'scripts/subscription-exec-server-worker-trampoline.py',
    'scripts/subscription-exec-worker-probe.py', 'scripts/subscription-exec-environment-metadata-parent.py',
    'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py',
    'scripts/subscription-appserver-metadata-transport.ts', 'scripts/subscription-appserver-metadata-pipe-child.py',
    'scripts/subscription-appserver-noenv.py', 'scripts/subscription-worker-lockdown.py', 'scripts/subscription-text-model-catalog.json',
    'scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh', 'scripts/subscription-cli-supervisor-child.py',
    'scripts/subscription-runtime-probe.py', 'scripts/subscription-runtime-child-probe.py', 'scripts/subscription-worker-boundary-child.py',
    'scripts/subscription-appserver-fixture-child.py', 'scripts/subscription-appserver-generation.ts',
    'evals/reality-compiler/subscription-appserver-metadata-transport.measure.ts', 'evals/reality-compiler/subscription-appserver-metadata-transport.measure.md'];
  const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const before = hashes();
  write('planned.json', { before, budgetMs: 30000, maximumJobMs: 180000, actualModelCalls: 0, productionReady: false,
    expected: 'actual initialize/thread metadata plus exact typed namespace advisory, turn/start refused before bridge write, confirmed owned local/remote cleanup',
    aggregateResourcesValidated: false, scope: 'BASIC_CAPSULE_NO_TURN_METADATA_ONLY; not inference, systemd resources or network-inertness' });
  let evidence: MetadataTransportEvidence | null = null;
  const late: LateGenerationEvidence[] = [];
  const started = performance.now();
  try {
    const adapter = createAppServerGenerationAdapter(createAppServerMetadataTransport(value => { evidence = value; }));
    const result = await adapter.generate({ request: { model: 'gpt-5.6-sol', system: METADATA_SYSTEM, user: 'No model turn is allowed.' },
      remainingBudgetMs: 30000 }, undefined, undefined, value => { late.push(structuredClone(value)); });
    const { wireRaw, stderrRaw, ...accounting } = result;
    writeFileSync(resolve(directory, 'stdout.log'), wireRaw, { flag: 'wx' });
    writeFileSync(resolve(directory, 'stderr.log'), stderrRaw, { flag: 'wx' });
    await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
    write('result.json', { accounting, evidence, late, elapsedMs: performance.now() - started, actualModelCalls: 0,
      stdoutBytes: Buffer.byteLength(wireRaw), stderrBytes: Buffer.byteLength(stderrRaw),
      stdoutSha256: createHash('sha256').update(wireRaw).digest('hex'), stderrSha256: createHash('sha256').update(stderrRaw).digest('hex') });
    expect(result).toMatchObject({ outcome: 'failed', error: 'TRANSPORT_WRITE_FAILED', json: null, jsonText: null,
      modelCalls: null, observedTurns: 0, cleanup: { local: 'confirmed', remote: 'confirmed' }, productionReady: false });
    expect(evidence).toMatchObject({ kind: 'ACTUAL_CLI_METADATA_ONLY', actualModelCalls: 0, credentialFilesRead: false,
      aggregateResourcesValidated: false, productionReady: false, error: null, refusedMethod: 'turn/start',
      admittedMethods: ['initialize', 'initialized', 'thread/start'], inputAckScope: 'supervisor-to-bridge-write-only',
      terminal: { mode: 'appserver-metadata-pipe', cleanup: { verified: true, namespaceEmpty: true, allObservedPidfdsESRCH: true } } });
    const frames = wireRaw.trim().split('\n').map(line => JSON.parse(line));
    expect(frames.some(frame => frame.id === 1 && frame.result)).toBe(true);
    expect(frames.some(frame => frame.id === 2 && frame.result?.thread?.ephemeral === true)).toBe(true);
    const warnings = frames.filter(frame => frame.method === 'configWarning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].params).toEqual({ summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null });
    expect(result.configurationAdvisories).toEqual([{ kind: 'linux-sandbox-user-namespace-unavailable',
      summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null,
      ...('emittedAtMs' in warnings[0] ? { emittedAtMs: warnings[0].emittedAtMs } : {}) }]);
    expect(frames.some(frame => frame.method === 'turn/started')).toBe(false);
    expect(result.outputAccounting).toMatchObject({ status: 'reported', receivedBytes: result.outputBytes,
      observedBytes: result.outputBytes, withheldBytes: 0 });
    expect(result.outputAccounting.receivedByStream.stdout).toBe(Buffer.byteLength(wireRaw));
    expect(result.outputAccounting.receivedByStream.stderr).toBe(Buffer.byteLength(stderrRaw));
    expect(late).toEqual([]);
    const after = hashes(); expect(after).toEqual(before);
    write('summary.json', { status: 'PASS', before, after, accounting, evidence, late, elapsedMs: performance.now() - started,
      actualModelCalls: 0, productionReady: false, aggregateResourcesValidated: false });
    console.log(`APPSERVER_METADATA_PIPE_PASS ${directory}`);
  } catch (error) {
    write('summary.json', { status: 'FAIL', before, after: hashes(), evidence, late, error: String(error),
      actualModelCalls: 0, productionReady: false, aggregateResourcesValidated: false });
    console.log(`APPSERVER_METADATA_PIPE_FAIL ${directory}`); throw error;
  }
}, 45000);
