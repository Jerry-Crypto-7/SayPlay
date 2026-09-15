/** Offline entry point. Live evidence requires the independent T11 product adapter and holdout. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { buildReport, digest, fileJournal, renderReport, runBenchmark, type Suite } from '../../scripts/measure-reality-compiler';
import { buildRuntimeWorld } from '../../src/ir/build';
import { createRuntime, step } from '../../src/sim/interpreter';
import { readSlot } from '../../src/sim/state';
import oracle from './oracle.json';
import surface from './museum.sim.json';

it('archives an explicitly offline development replay and produces NOT_RUN cold gates', async () => {
  const runId = randomUUID();
  const directory = resolve('evals/reality-compiler/runs', runId);
  mkdirSync(directory, { recursive: true });
  const suite: Suite = { status: 'development', oracleSha256: digest(oracle), cases: [{
    id: 'museum-development', kind: 'complete', source: readFileSync('evals/reality-compiler/museum-source.txt', 'utf8'),
    intervention: 'Change the countdown from 20 to 10 seconds.', clarification: null,
  }] };
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();
  const run = await runBenchmark(suite, { runId, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0,
    model: 'none', modelConfig: { fixture: 'museum', runtime: 'node', browserFrameMeasured: false },
    origin: 'offline', suiteSha256: digest(suite), authorized: false, spendLimitUsd: null, maxCalls: 1, maxWallMs: 60000,
  }, { journal: fileJournal(resolve(directory, 'journal.jsonl')), redact: (value) => value,
    adapter: {
      execute: async (_input, phase, _previous, ctx) => ctx.stage('validation', async () => {
        const scenarios = phase === 'create' ? oracle.cases : [oracle.cases[0]];
        const observed = scenarios.map((scenario) => {
          const sim = structuredClone(surface);
          if (phase === 'edit') sim.rules.start_countdown.actions[1].durationTicks = oracle.changedLimitTicks;
          const built = buildRuntimeWorld(sim);
          if (!built.ok) throw new Error(built.reason);
          const runtime = createRuntime({ ...built.world, trace: scenario.inputs });
          while (runtime.tick < scenario.snapshotTick) step(runtime, scenario.inputs.filter((i) => i.tick === runtime.tick));
          const outcome = { caseUnlocked: readSlot(runtime.layout, runtime.state, 'e:case:locked') === 0,
            alarm: readSlot(runtime.layout, runtime.state, 'f:alarm') === 1 };
          expect(outcome).toEqual(phase === 'create' ? scenario.expected : oracle.changedExpected);
          return { id: scenario.id, tick: runtime.tick, outcome };
        });
        // Úspěch offline replaye, ne měření frame/browserové cesty.
        return { completed: true, artifact: observed };
      }),
      evaluate: async () => ({ invariants: null, criticalSupported: null, criticalCitations: null,
        otherCitations: null, rejectedUnchanged: null, problematicBlocked: null, rules: null,
        branchDelta: true, visualUsable: null }),
    },
  });
  const report = buildReport(run);
  expect(report.completion.completed).toBe(3);
  expect(Object.values(report.gates).every((g) => g === 'NOT_RUN')).toBe(true);
  writeFileSync(resolve(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync('evals/reality-compiler/report.md', renderReport(run) +
    `\nOffline kontrola: 8 původních muzejních oracle případů a změněný výsledek, každý 3×. ` +
    `Čas je Node replay, nikoli ovladatelný browserový frame. Model se nevolal.\n\nArchiv: runs/${runId}/journal.jsonl a run.json.\n`);
});
