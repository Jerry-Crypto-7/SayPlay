/** Actual no-turn metadata with owned systemd resource admission and cleanup. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createAppServerGenerationAdapter, LINUX_SANDBOX_ADVISORY_SUMMARY, type LateGenerationEvidence } from '../../scripts/subscription-appserver-generation';
import { createSystemdAppServerMetadataTransport, METADATA_SYSTEM, type MetadataTransportEvidence } from '../../scripts/subscription-appserver-metadata-transport';

const count = z.number().int().safe().nonnegative(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const readback = z.object({ memoryMax: z.literal('2147483648'), memorySwapMax: z.literal('0'), pidsMax: z.literal('64') }).strict();
const resource = z.object({ unit: z.string().regex(/^codex-cli-resource-[a-f0-9]{32}\.service$/), uid: count, leaf: z.string(),
  aggregateResourceReadbackValidated: z.literal(true), candidateExhaustionValidated: z.literal(false), relaySha256: hash, probeSha256: hash,
  limits: z.object({ memoryMaxBytes: z.literal(2147483648), swapMaxBytes: z.literal(0), tasksMax: z.literal(64),
    guardianMs: z.literal(220000), termGraceMs: z.literal(5000), innerCommandMs: z.literal(200000) }).strict(),
  control: z.object({ driverPid: count.min(2), driverCgroup: z.string(), managerPid: count.min(2), managerUid: count, managerGid: count,
    managerIdentityProfile: z.literal('private-socket-peer-v1'), managerStartTimeTicks: z.string().regex(/^[0-9]+$/).max(32),
    managerCgroup: z.string(), managerSocket: z.object({ path: z.string(), components: z.array(z.object({
      dev: count, ino: count, mode: count, uid: count, gid: count }).strict()).length(5) }).strict(),
    unitMainPid: count.min(2), unitMainCgroup: z.string(), unitMainStartTimeTicks: z.string().regex(/^[0-9]+$/).max(32) }).strict(), readback,
}).strict();
const readySchema = z.object({ sandbox: z.object({ uid: count }).passthrough(),
  binarySha256: z.literal('a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'),
  bwrapSha256: z.literal('77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'),
  appServerMetadataPipeBoundary: z.object({ helperSha256: z.object({ 'subscription-appserver-metadata-pipe-child.py': hash,
    'subscription-appserver-noenv.py': hash, 'subscription-worker-lockdown.py': hash, 'subscription-text-model-catalog.json': hash }).strict() }).strict(),
  systemdFixtureBoundary: resource,
}).passthrough();
const terminalSchema = z.object({ systemdFixtureBoundary: resource.extend({ preStartReadback: readback,
  cleanup: z.object({ unitAbsent: z.literal(true), leafAbsent: z.literal(true), systemdRunClosed: z.literal(true) }).strict(),
  relayErrors: z.array(z.string()).length(0) }).strict() }).passthrough();

it.skipIf(process.env.RC_SYSTEMD_APPSERVER_METADATA_PIPE_SMOKE !== '1')('observes actual metadata and refused turn within the owned systemd resource boundary', async () => {
  const directory = resolve('scratch', `session8-systemd-appserver-metadata-pipe-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const paths = ['scripts/subscription-exec-server-worker-gate.py', 'scripts/subscription-exec-server-worker-trampoline.py',
    'scripts/subscription-exec-worker-probe.py', 'scripts/subscription-exec-environment-metadata-parent.py',
    'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py',
    'scripts/subscription-appserver-metadata-transport.ts', 'scripts/subscription-appserver-fixture-transport.ts',
    'scripts/subscription-systemd-fixture-transport.py', 'scripts/subscription-systemd-cli-probe.py',
    'scripts/subscription-appserver-metadata-pipe-child.py', 'scripts/subscription-appserver-noenv.py',
    'scripts/subscription-worker-lockdown.py', 'scripts/subscription-text-model-catalog.json',
    'scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh', 'scripts/subscription-cli-supervisor-child.py',
    'scripts/subscription-runtime-probe.py', 'scripts/subscription-runtime-child-probe.py', 'scripts/subscription-worker-boundary-child.py',
    'scripts/subscription-appserver-fixture-child.py', 'scripts/subscription-appserver-generation.ts',
    'evals/reality-compiler/subscription-appserver-systemd-metadata-transport.measure.ts',
    'evals/reality-compiler/subscription-appserver-systemd-metadata-transport.measure.md'];
  const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const before = hashes();
  write('planned.json', { before, budgetMs: 30000, maximumJobMs: 180000, actualModelCalls: 0, productionReady: false,
    expected: 'actual initialize/thread + exact raw/typed advisory + turn refusal before bridge write + owned namespace/unit cleanup',
    aggregateResourceReadbackValidated: true, candidateExhaustionValidated: false });
  let evidence: MetadataTransportEvidence | null = null;
  const late: LateGenerationEvidence[] = [], began = performance.now();
  try {
    const adapter = createAppServerGenerationAdapter(createSystemdAppServerMetadataTransport(value => { evidence = value; }));
    const result = await adapter.generate({ request: { model: 'gpt-5.6-sol', system: METADATA_SYSTEM, user: 'No model turn is allowed.' },
      remainingBudgetMs: 30000 }, undefined, undefined, value => { late.push(structuredClone(value)); });
    const { wireRaw, stderrRaw, ...accounting } = result;
    writeFileSync(resolve(directory, 'stdout.log'), wireRaw, { flag: 'wx' }); writeFileSync(resolve(directory, 'stderr.log'), stderrRaw, { flag: 'wx' });
    await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
    const captured = evidence as MetadataTransportEvidence | null;
    if (captured?.systemdFailure !== undefined) write('systemd-failure.json', captured.systemdFailure);
    write('result.json', { accounting, evidence, late, elapsedMs: performance.now() - began, actualModelCalls: 0,
      stdoutBytes: Buffer.byteLength(wireRaw), stderrBytes: Buffer.byteLength(stderrRaw),
      stdoutSha256: createHash('sha256').update(wireRaw).digest('hex'), stderrSha256: createHash('sha256').update(stderrRaw).digest('hex') });
    expect(result).toMatchObject({ outcome: 'failed', error: 'TRANSPORT_WRITE_FAILED', json: null, jsonText: null,
      modelCalls: null, observedTurns: 0, cleanup: { local: 'confirmed', remote: 'confirmed' }, productionReady: false });
    expect(evidence).toMatchObject({ kind: 'ACTUAL_CLI_METADATA_ONLY', actualModelCalls: 0, credentialFilesRead: false, productionReady: false,
      aggregateResourcesValidated: true, error: null, refusedMethod: 'turn/start', admittedMethods: ['initialize', 'initialized', 'thread/start'],
      terminal: { mode: 'appserver-metadata-pipe', cleanup: { verified: true, namespaceEmpty: true, allObservedPidfdsESRCH: true } } });
    const ready = readySchema.parse(captured?.ready), terminal = terminalSchema.parse(captured?.terminal), boundary = ready.systemdFixtureBoundary;
    expect(ready.sandbox.uid).toBe(boundary.uid); expect(boundary.control.managerUid).toBe(boundary.uid);
    const leaf = `/user.slice/user-${boundary.uid}.slice/user@${boundary.uid}.service/app.slice/${boundary.unit}`;
    expect(boundary.leaf).toBe('/sys/fs/cgroup' + leaf); expect(boundary.control.unitMainCgroup).toBe(leaf);
    expect(new Set([boundary.control.driverPid, boundary.control.managerPid, boundary.control.unitMainPid]).size).toBe(3);
    for (const cgroup of [boundary.control.driverCgroup, boundary.control.managerCgroup]) {
      expect(cgroup.startsWith('/')).toBe(true); expect(cgroup === leaf || cgroup.startsWith(leaf + '/')).toBe(false);
    }
    expect(boundary.control.managerSocket.path).toBe(`/run/user/${boundary.uid}/systemd/private`);
    boundary.control.managerSocket.components.forEach((part, index) => expect(part.mode & 0xf000).toBe(index === 4 ? 0xc000 : 0x4000));
    expect(boundary.control.managerSocket.components[4].uid).toBe(boundary.uid);
    expect(boundary.relaySha256).toBe(before['scripts/subscription-systemd-fixture-transport.py']);
    expect(boundary.probeSha256).toBe(before['scripts/subscription-systemd-cli-probe.py']);
    expect(ready.appServerMetadataPipeBoundary.helperSha256).toEqual(Object.fromEntries([
      'subscription-appserver-metadata-pipe-child.py', 'subscription-appserver-noenv.py', 'subscription-worker-lockdown.py',
      'subscription-text-model-catalog.json'].map(name => [name, before['scripts/' + name]])));
    const { preStartReadback, cleanup, relayErrors, ...terminalIdentity } = terminal.systemdFixtureBoundary;
    expect(terminalIdentity).toEqual(boundary); expect(preStartReadback).toEqual(boundary.readback);
    expect(cleanup).toEqual({ unitAbsent: true, leafAbsent: true, systemdRunClosed: true }); expect(relayErrors).toEqual([]);
    const frames = wireRaw.trim().split('\n').map(line => JSON.parse(line)), warnings = frames.filter(frame => frame.method === 'configWarning');
    expect(frames.some(frame => frame.id === 1 && frame.result)).toBe(true);
    expect(frames.some(frame => frame.id === 2 && frame.result?.thread?.ephemeral === true)).toBe(true);
    expect(frames.some(frame => frame.method === 'turn/started')).toBe(false); expect(warnings).toHaveLength(1);
    expect(warnings[0].params).toEqual({ summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null });
    expect(result.configurationAdvisories).toEqual([{ kind: 'linux-sandbox-user-namespace-unavailable', summary: LINUX_SANDBOX_ADVISORY_SUMMARY,
      details: null, ...('emittedAtMs' in warnings[0] ? { emittedAtMs: warnings[0].emittedAtMs } : {}) }]);
    expect(result.outputAccounting).toMatchObject({ status: 'reported', receivedBytes: result.outputBytes, observedBytes: result.outputBytes, withheldBytes: 0 });
    expect(result.outputAccounting.receivedByStream).toEqual({ stdout: Buffer.byteLength(wireRaw), stderr: Buffer.byteLength(stderrRaw) });
    expect(late).toEqual([]); const after = hashes(); expect(after).toEqual(before);
    write('summary.json', { status: 'PASS', before, after, accounting, evidence, late, elapsedMs: performance.now() - began, actualModelCalls: 0, productionReady: false });
    console.log(`SYSTEMD_APPSERVER_METADATA_PIPE_PASS ${directory}`);
  } catch (error) {
    write('summary.json', { status: 'FAIL', before, after: hashes(), evidence, late, error: String(error), actualModelCalls: 0, productionReady: false });
    console.log(`SYSTEMD_APPSERVER_METADATA_PIPE_FAIL ${directory}`); throw error;
  }
}, 45000);
