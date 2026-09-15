/** Explicit credential-free integration only. No login, prompt or inference. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runCliSupervisorProbe } from '../../scripts/subscription-cli-probe-transport';

it.skipIf(process.env.RC_CLI_PROBE_SMOKE !== '1')('runs fixed actual CLI and cancellation through the TS transport', async () => {
  const directory = resolve('scratch', `session8-cli-ts-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const paths = ['scripts/subscription-appserver-metadata-pipe-child.py',
    'scripts/subscription-exec-server-worker-gate.py', 'scripts/subscription-exec-server-worker-trampoline.py',
    'scripts/subscription-exec-worker-probe.py', 'scripts/subscription-exec-environment-metadata-parent.py',
    'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py',
    'scripts/subscription-cli-probe-transport.ts', 'scripts/subscription-cli-supervisor.py',
    'scripts/subscription-cli-supervisor.sh', 'scripts/subscription-cli-supervisor-child.py',
    'scripts/subscription-runtime-probe.py', 'scripts/subscription-runtime-child-probe.py',
    'scripts/subscription-worker-lockdown.py', 'scripts/subscription-worker-boundary-child.py', 'scripts/subscription-appserver-noenv.py',
    'scripts/subscription-text-model-catalog.json', 'scripts/subscription-appserver-fixture-child.py'];
  const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const before = hashes();
  writeFileSync(resolve(directory, 'planned.json'), JSON.stringify({ before, cases: ['version', 'private-sentinel', 'cancel', 'kill-grace', 'output-limit'],
    modelCalls: 0, credentials: false, productionReady: false }, null, 2), { flag: 'wx' });
  const results: unknown[] = [];
  try {
    for (const name of ['version', 'private-sentinel', 'cancel', 'kill-grace', 'output-limit'] as const) {
      const controller = new AbortController(); let cancellation: ReturnType<typeof setTimeout> | undefined;
      const events: unknown[] = [];
      const result = await runCliSupervisorProbe({ mode: name === 'cancel' ? 'setsid' : name === 'kill-grace' ? 'stopped-cli'
        : name === 'output-limit' ? 'paced-output' : name, signal: controller.signal,
        observe(frame) {
          events.push(frame);
          if (name === 'cancel' && (frame as { type: string }).type === 'started') cancellation = setTimeout(() => controller.abort(), 1000);
          if (name === 'kill-grace' && (frame as { type: string }).type === 'fixture_ready') controller.abort();
        } });
      clearTimeout(cancellation);
      results.push({ name, result });
      writeFileSync(resolve(directory, `${name}.json`), JSON.stringify({ events, result }, null, 2), { flag: 'wx' });
      expect(result).toMatchObject({ outcome: name === 'cancel' || name === 'kill-grace' ? 'cancelled' : name === 'output-limit' ? 'failed' : 'completed', cleanup: 'verified',
        localClose: { code: name === 'output-limit' ? 1 : 0 }, modelCalls: 0, credentialFilesRead: false, productionReady: false });
      if (name === 'kill-grace') {
        expect(result.terminal?.terminationElapsedMs).toBeGreaterThanOrEqual(5000);
        expect(result.terminal).toMatchObject({ fixture: { state: 'T', executable: '/usr/bin/codex' }, cleanup: { killSent: true } });
      }
      if (name === 'output-limit') {
        expect(result.error).toBe('OUTPUT_LIMIT'); expect(result.outputBytes).toBeLessThanOrEqual(8388608);
        expect(result.terminal?.outputBytes).toBeGreaterThan(8388608);
      }
    }
    const after = hashes(); expect(after).toEqual(before);
    writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ status: 'PASS', results, before, after,
      scope: 'Credential-free actual CLI and synthetic cancellation; not production authentication, network or aggregate limits.' }, null, 2), { flag: 'wx' });
    console.log(`CLI_TS_SMOKE_PASS ${directory}`);
  } catch (error) {
    writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ status: 'FAIL', results, before, after: hashes(), error: String(error) }, null, 2), { flag: 'wx' });
    throw error;
  }
}, 240000);
