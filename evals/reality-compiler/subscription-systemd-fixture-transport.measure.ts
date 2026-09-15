/** Actual owned systemd/capsule pipes; the model protocol is an authored fixture. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createAppServerGenerationAdapter, type LateGenerationEvidence } from '../../scripts/subscription-appserver-generation';
import { createSystemdAppServerFixtureTransport, type FixtureEvidence } from '../../scripts/subscription-appserver-fixture-transport';

const count = z.number().int().safe().nonnegative(), pid = count.positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const readback = z.object({ memoryMax: z.literal('2147483648'), memorySwapMax: z.literal('0'), pidsMax: z.literal('64') }).strict();
const boundary = z.object({ unit: z.string().regex(/^codex-cli-resource-[a-f0-9]{32}\.service$/), uid: count,
  aggregateResourceReadbackValidated: z.literal(true), candidateExhaustionValidated: z.literal(false),
  leaf: z.string(), relaySha256: hash, probeSha256: hash,
  limits: z.object({ memoryMaxBytes: z.literal(2147483648), swapMaxBytes: z.literal(0), tasksMax: z.literal(64),
    guardianMs: z.literal(220000), termGraceMs: z.literal(5000), innerCommandMs: z.literal(200000) }).strict(),
  control: z.object({ driverPid: pid, driverCgroup: z.string(), managerPid: pid, managerCgroup: z.string(),
    managerIdentityProfile: z.literal('private-socket-peer-v1'), managerUid: count, managerGid: count,
    managerStartTimeTicks: z.string().regex(/^[0-9]+$/).max(32),
    managerSocket: z.object({ path: z.string().max(4096), components: z.array(z.object({
      dev: count, ino: count, mode: count, uid: count, gid: count }).strict()).length(5) }).strict(),
    unitMainPid: pid, unitMainCgroup: z.string(), unitMainStartTimeTicks: z.string().regex(/^[0-9]+$/).max(32) }).strict(), readback,
}).strict();
const readySchema = z.object({ binarySha256: z.literal('a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'),
  sandbox: z.object({ uid: count }).passthrough(),
  appServerFixtureBoundary: z.object({ helperSha256: z.object({
    'subscription-appserver-fixture-child.py': hash, 'subscription-worker-lockdown.py': hash }).strict() }).strict(),
  bwrapSha256: z.literal('77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'), systemdFixtureBoundary: boundary }).passthrough();
const terminalSchema = z.object({ outputBytes: count, observedOutputSha256: hash, outputComplete: z.boolean(),
  systemdFixtureBoundary: boundary.extend({ preStartReadback: readback,
    cleanup: z.object({ unitAbsent: z.literal(true), leafAbsent: z.literal(true), systemdRunClosed: z.literal(true) }).strict(),
    relayErrors: z.array(z.string()).length(0) }).strict(),
}).passthrough();

it.skipIf(process.env.RC_SYSTEMD_APPSERVER_FIXTURE_SMOKE !== '1')('runs authored protocol through the owned systemd resource boundary', async () => {
  const directory = resolve('scratch', `session8-systemd-appserver-fixture-ts-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const paths = ['scripts/subscription-appserver-metadata-pipe-child.py',
    'scripts/subscription-exec-server-worker-gate.py', 'scripts/subscription-exec-server-worker-trampoline.py',
    'scripts/subscription-exec-worker-probe.py', 'scripts/subscription-exec-environment-metadata-parent.py',
    'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py',
    'scripts/subscription-appserver-fixture-transport.ts', 'scripts/subscription-systemd-fixture-transport.py',
    'scripts/subscription-systemd-cli-probe.py', 'scripts/subscription-appserver-fixture-child.py',
    'scripts/subscription-appserver-generation.ts', 'scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh',
    'scripts/subscription-cli-supervisor-child.py', 'scripts/subscription-runtime-probe.py', 'scripts/subscription-runtime-child-probe.py',
    'scripts/subscription-worker-lockdown.py', 'scripts/subscription-worker-boundary-child.py', 'scripts/subscription-appserver-noenv.py',
    'scripts/subscription-text-model-catalog.json', 'evals/reality-compiler/subscription-systemd-fixture-transport.measure.ts',
    'evals/reality-compiler/subscription-systemd-fixture-transport.measure.md'];
  const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const before = hashes(), scenarios = ['normal', 'cancel', 'output-limit'] as const;
  const budgets = { normal: 30000, cancel: 30000, 'output-limit': 60000 } as const;
  const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  write('planned.json', { before, scenarios, budgetPerScenarioMs: budgets, maximumJobMs: 180000,
    actualModelCalls: 0, productionReady: false, scope: 'AUTHORED_PROTOCOL_FIXTURE; no authentication, network or inference',
    limitation: 'Candidate limits readback and owned cleanup; no candidate-limit exhaustion or hostile-descendant guarantee.' });
  const results: unknown[] = [], runtimeObservations: unknown[] = [], units = new Set<string>();
  try {
    for (const scenario of scenarios) {
      let evidence: FixtureEvidence | null = null;
      const late: LateGenerationEvidence[] = [], controller = new AbortController();
      const adapter = createAppServerGenerationAdapter(createSystemdAppServerFixtureTransport(scenario, value => { evidence = value; }));
      const start = performance.now();
      const result = await adapter.generate({ request: { model: 'gpt-5.6-sol', system: 'Authored protocol fixture only.', user: 'Run fixed fixture.' },
        remainingBudgetMs: budgets[scenario] }, controller.signal, () => { if (scenario === 'cancel') controller.abort(); },
        value => { late.push(structuredClone(value)); });
      const elapsedMs = performance.now() - start;
      const { wireRaw, stderrRaw, ...accounting } = result;
      writeFileSync(resolve(directory, `${scenario}-stdout.log`), wireRaw, { flag: 'wx' });
      writeFileSync(resolve(directory, `${scenario}-stderr.log`), stderrRaw, { flag: 'wx' });
      // Evidence is delivered synchronously before the cleanup continuation. Keep late events separate.
      await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
      const entry = { scenario, elapsedMs, accounting, evidence, late, actualModelCalls: 0,
        retainedStdoutBytes: Buffer.byteLength(wireRaw), retainedStderrBytes: Buffer.byteLength(stderrRaw),
        stdoutSha256: createHash('sha256').update(wireRaw).digest('hex'), stderrSha256: createHash('sha256').update(stderrRaw).digest('hex'),
        rawScope: scenario === 'output-limit' ? 'bounded retained prefix; received crossing bytes and withheld tail are counts, not retained body' : 'retained received protocol streams' };
      results.push(entry); write(`${scenario}.json`, entry);
      // Keep the bounded stage trace/inner failure terminal before any assertion.
      // This is the received structured failure receipt, not reconstructed raw wire.
      const captured = evidence as FixtureEvidence | null;
      if (captured?.systemdFailure !== undefined) write(`${scenario}-systemd-failure.json`, captured.systemdFailure);
      // This assertion precedes every possible subsequent factory invocation: unknown cleanup stops the run.
      expect(result.cleanup).toEqual({ local: 'confirmed', remote: 'confirmed' });
      expect(evidence).toMatchObject({ actualModelCalls: 0, credentialFilesRead: false, productionReady: false, error: null,
        aggregateResourcesValidated: true, terminal: { cleanup: { verified: true, namespaceEmpty: true, allObservedPidfdsESRCH: true } } });
      const ready = readySchema.parse(captured?.ready), terminal = terminalSchema.parse(captured?.terminal);
      expect(ready.appServerFixtureBoundary.helperSha256).toEqual({
        'subscription-appserver-fixture-child.py': before['scripts/subscription-appserver-fixture-child.py'],
        'subscription-worker-lockdown.py': before['scripts/subscription-worker-lockdown.py'],
      });
      const resource = ready.systemdFixtureBoundary;
      expect(resource.control.managerUid).toBe(resource.uid);
      expect(ready.sandbox.uid).toBe(resource.uid);
      expect(resource.control.managerSocket.path).toBe(`/run/user/${resource.uid}/systemd/private`);
      expect(resource.control.managerSocket.components[4].uid).toBe(resource.uid);
      for (const component of resource.control.managerSocket.components.slice(0, 4)) expect(component.mode & 0xf000).toBe(0x4000);
      expect(resource.control.managerSocket.components[4].mode & 0xf000).toBe(0xc000);
      expect(resource.leaf).toBe(`/sys/fs/cgroup/user.slice/user-${resource.uid}.slice/user@${resource.uid}.service/app.slice/${resource.unit}`);
      const relativeLeaf = resource.leaf.slice('/sys/fs/cgroup'.length);
      expect(resource.control.unitMainCgroup).toBe(relativeLeaf);
      for (const cgroup of [resource.control.driverCgroup, resource.control.managerCgroup]) {
        expect(cgroup.startsWith('/')).toBe(true);
        expect(cgroup === relativeLeaf || cgroup.startsWith(relativeLeaf + '/')).toBe(false);
      }
      expect(resource.control.driverPid).not.toBe(resource.control.unitMainPid);
      expect(resource.control.managerPid).not.toBe(resource.control.unitMainPid);
      expect(units.has(resource.unit)).toBe(false); units.add(resource.unit);
      expect(resource.relaySha256).toBe(before['scripts/subscription-systemd-fixture-transport.py']);
      expect(resource.probeSha256).toBe(before['scripts/subscription-systemd-cli-probe.py']);
      const { preStartReadback, cleanup, relayErrors, ...terminalResource } = terminal.systemdFixtureBoundary;
      expect(terminalResource).toEqual(resource); expect(preStartReadback).toEqual(resource.readback);
      expect(cleanup).toEqual({ unitAbsent: true, leafAbsent: true, systemdRunClosed: true }); expect(relayErrors).toEqual([]);
      runtimeObservations.push({ scenario, binarySha256: ready.binarySha256, bwrapSha256: ready.bwrapSha256 });
      expect(result.outputAccounting).toMatchObject({ status: 'reported', receivedBytes: result.outputBytes,
        observedBytes: terminal.outputBytes, withheldBytes: terminal.outputBytes - result.outputBytes });
      expect(result.outputAccounting.receivedByStream.stdout + result.outputAccounting.receivedByStream.stderr).toBe(result.outputBytes);
      expect(result.modelCalls).toBeNull(); expect(result.observedTurns).toBe(1); expect(result.productionReady).toBe(false);
      expect(late).toEqual([]);
      if (scenario === 'normal') expect(result).toMatchObject({ outcome: 'completed', json: { authoredFixture: true, actualModelCalls: 0 } });
      else if (scenario === 'cancel') expect(result).toMatchObject({ outcome: 'failed', error: 'GENERATION_CANCELLED' });
      else {
        expect(result.error).toBe('OUTPUT_LIMIT'); expect(result.outputBytes).toBeGreaterThan(8388608);
        expect(result.outputBytes).toBeLessThanOrEqual(8388608 + 4096);
        expect(Buffer.byteLength(wireRaw) + Buffer.byteLength(stderrRaw)).toBeLessThanOrEqual(8388608);
      }
    }
    const after = hashes(); expect(after).toEqual(before);
    write('summary.json', { status: 'PASS', results, before, after, runtimeObservations, actualModelCalls: 0, productionReady: false });
    console.log(`SYSTEMD_APPSERVER_FIXTURE_TS_PASS ${directory}`);
  } catch (error) {
    write('summary.json', { status: 'FAIL', results, before, after: hashes(), runtimeObservations, error: String(error), actualModelCalls: 0, productionReady: false });
    console.log(`SYSTEMD_APPSERVER_FIXTURE_TS_FAIL ${directory}`); throw error;
  }
}, 160000);
