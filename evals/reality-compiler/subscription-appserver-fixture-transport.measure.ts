/** Explicit actual OS pipe integration; all model events are authored fixtures. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createAppServerGenerationAdapter } from '../../scripts/subscription-appserver-generation';
import { createAppServerFixtureTransport, type FixtureEvidence } from '../../scripts/subscription-appserver-fixture-transport';

it.skipIf(process.env.RC_APPSERVER_FIXTURE_SMOKE !== '1')('runs authored normal/cancel/output-limit through actual TS to capsule pipes', async () => {
  const directory = resolve('scratch', `session8-appserver-fixture-ts-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const paths = ['scripts/subscription-appserver-metadata-pipe-child.py',
    'scripts/subscription-exec-server-worker-gate.py', 'scripts/subscription-exec-server-worker-trampoline.py',
    'scripts/subscription-exec-worker-probe.py', 'scripts/subscription-exec-environment-metadata-parent.py',
    'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py',
    'scripts/subscription-appserver-fixture-transport.ts', 'scripts/subscription-appserver-fixture-child.py',
    'scripts/subscription-appserver-generation.ts', 'scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh',
    'scripts/subscription-cli-supervisor-child.py', 'scripts/subscription-runtime-probe.py', 'scripts/subscription-runtime-child-probe.py',
    'scripts/subscription-worker-lockdown.py', 'scripts/subscription-worker-boundary-child.py', 'scripts/subscription-appserver-noenv.py',
    'scripts/subscription-text-model-catalog.json', 'evals/reality-compiler/subscription-appserver-fixture-transport.measure.ts'];
  const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const before = hashes(), scenarios = ['normal', 'cancel', 'output-limit'] as const;
  const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  write('planned.json', { before, scenarios, budgetPerScenarioMs: { normal: 20000, cancel: 20000, 'output-limit': 60000 }, actualModelCalls: 0, productionReady: false,
    scope: 'AUTHORED_PROTOCOL_FIXTURE; no auth/network/model. Basic capsule aggregate resources not validated.' });
  const results: unknown[] = [];
  try {
    for (const scenario of scenarios) {
      let evidence: FixtureEvidence | null = null;
      const controller = new AbortController();
      const adapter = createAppServerGenerationAdapter(createAppServerFixtureTransport(scenario, value => { evidence = value; }));
      const result = await adapter.generate({ request: { model: 'gpt-5.6-sol', system: 'Authored protocol fixture only.', user: 'Run fixed fixture.' },
        remainingBudgetMs: scenario === 'output-limit' ? 60000 : 20000 }, controller.signal, () => { if (scenario === 'cancel') controller.abort(); });
      const { wireRaw, stderrRaw, ...accounting } = result;
      writeFileSync(resolve(directory, `${scenario}-stdout.log`), wireRaw, { flag: 'wx' });
      writeFileSync(resolve(directory, `${scenario}-stderr.log`), stderrRaw, { flag: 'wx' });
      const entry = { scenario, accounting, evidence, retainedStdoutBytes: Buffer.byteLength(wireRaw),
        retainedStderrBytes: Buffer.byteLength(stderrRaw), stdoutSha256: createHash('sha256').update(wireRaw).digest('hex'),
        stderrSha256: createHash('sha256').update(stderrRaw).digest('hex'), actualModelCalls: 0,
        rawScope: scenario === 'output-limit' ? 'bounded retained prefix; crossing and later excess not retained' : 'retained received protocol streams' };
      results.push(entry); write(`${scenario}.json`, entry);
      expect(result.cleanup).toEqual({ local: 'confirmed', remote: 'confirmed' });
      const observed = (evidence as FixtureEvidence | null)?.terminal as { outputBytes: number } | null;
      expect(result.outputAccounting).toMatchObject({ status: 'reported', receivedBytes: result.outputBytes,
        observedBytes: observed?.outputBytes, withheldBytes: (observed?.outputBytes ?? NaN) - result.outputBytes });
      expect(result.outputAccounting.receivedByStream.stdout + result.outputAccounting.receivedByStream.stderr).toBe(result.outputBytes);
      expect(evidence).toMatchObject({ actualModelCalls: 0, credentialFilesRead: false, productionReady: false,
        aggregateResourcesValidated: false, terminal: { cleanup: { verified: true, namespaceEmpty: true, allObservedPidfdsESRCH: true } } });
      if (scenario === 'normal') expect(result).toMatchObject({ outcome: 'completed', json: { authoredFixture: true, actualModelCalls: 0 } });
      else if (scenario === 'cancel') expect(result).toMatchObject({ outcome: 'failed', error: 'GENERATION_CANCELLED' });
      else {
        expect(result.error).toBe('OUTPUT_LIMIT'); expect(result.outputBytes).toBeGreaterThan(8388608);
        expect(result.outputBytes).toBeLessThanOrEqual(8388608 + 4096);
        expect(Buffer.byteLength(wireRaw) + Buffer.byteLength(stderrRaw)).toBeLessThanOrEqual(8388608);
      }
    }
    const after = hashes(); expect(after).toEqual(before);
    write('summary.json', { status: 'PASS', results, before, after, actualModelCalls: 0, productionReady: false });
    console.log(`APPSERVER_FIXTURE_TS_PASS ${directory}`);
  } catch (error) {
    write('summary.json', { status: 'FAIL', results, before, after: hashes(), error: String(error), actualModelCalls: 0, productionReady: false });
    console.log(`APPSERVER_FIXTURE_TS_FAIL ${directory}`);
    throw error;
  }
}, 140000);
