/** Operational recovery only: preserve the interrupted prefix; never retune or restart measured rows. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { gameSpecHash, type GameSpecV1 } from '@/play/spec';
import type { ActionWitness } from '@/play/arcade/witness';
import type { IntentTriple } from '@/play/intent/contract';
import { scoreTriples, sameEnvironment } from '../../p41/score';
import { prepareDrafting } from '../../p41/after-harness';

type Label = { id: string; sentence: string; hero: string | null; setting: string | null; essential: IntentTriple[]; unsupported: boolean };
type Row = {
  id: string; sentence: string; seed: number; milliseconds: number; built: boolean;
  score: ReturnType<typeof scoreTriples>; hero: boolean | null; environment: boolean | null; error: string | null;
  spec?: GameSpecV1; specHash?: string; worldHash?: string; witnesses?: readonly ActionWitness[];
  honesty?: Awaited<ReturnType<typeof honestyForSpec>>; verification?: unknown;
};
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const out = 'evals/play/p42/round2';
const retryWrite = (path: string, text: string, exclusive = false): void => {
  const delays = [25, 50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(path, text, exclusive ? { flag: 'wx' } : undefined); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') || attempt >= delays.length) throw error;
      // Only checkpoint I/O is retried; a generated observation is never rerun.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
    }
  }
};
const save = (name: string, data: unknown, exclusive = false) => retryWrite(`${out}/${name}`, JSON.stringify(data, null, 2) + '\n', exclusive);
const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();

it('P42 round2 recovery of the exact interrupted prefix with unchanged measurement protocol', async () => {
  if (process.env.P42_ROUND2_RESUME_INTERRUPTED !== '1') throw new Error('Recovery only: explicitly set P42_ROUND2_RESUME_INTERRUPTED=1 after verifying the frozen source.');
  for (const name of ['final-resumed.json', 'final-resumed.md', 'golden-resumed.log']) if (existsSync(`${out}/${name}`)) throw new Error(`Recovery output already exists: ${name}. No overwrite or automatic second recovery is allowed.`);
  const originalBytes = readFileSync(`${out}/final.json`);
  const original = JSON.parse(originalBytes.toString()) as {
    startedAt: string; commit: string; datasetSha256: string; sourceFingerprint: string;
    seeds: number[]; lane: string; calls: number; state: string; rows: Row[];
  };
  expect(original.state).toBe('in-progress');
  expect(original.rows).toHaveLength(47);
  expect(original.sourceFingerprint).toBe('ab6a945773973c97e3161972e4183e24ca710b4c308e623bb3fe5a5b55cea9b7');
  expect(original.lane).toBe('quick');
  expect(original.calls).toBe(0);
  const bytes = readFileSync(`${out}/sentences.json`);
  const seal = JSON.parse(readFileSync(`${out}/dataset-seal.json`, 'utf8'));
  expect(sha(bytes)).toBe(seal.sha256);
  expect(original.datasetSha256).toBe(seal.sha256);
  const labels = (JSON.parse(bytes.toString()) as { groups: Record<string, Label[]> }).groups['held-out']!;
  expect(labels).toHaveLength(64);
  const seeds = [1, 2, 3, 4, 5];
  expect(original.seeds).toEqual(seeds);
  const planned = labels.flatMap(label => seeds.map(seed => ({ label, seed })));
  expect(new Set(labels.map(label => label.id)).size).toBe(64);
  expect(original.rows.map(row => ({ id: row.id, sentence: row.sentence, seed: row.seed })))
    .toEqual(planned.slice(0, 47).map(({ label, seed }) => ({ id: label.id, sentence: label.sentence, seed })));
  for (const row of original.rows) {
    expect(Number.isFinite(row.milliseconds) && row.milliseconds >= 0).toBe(true);
    expect(typeof row.built).toBe('boolean');
    expect(typeof row.score.preserved).toBe('boolean');
  }
  const preservedPrefixSha256 = sha(JSON.stringify(original.rows));
  const paths = git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'evals/play/p41/*.ts', 'evals/play/p42/*.ts', 'evals/play/p42/round2/*.ts', 'package.json', 'package-lock.json', 'vitest.config.mts', 'vitest.measure.mts').split('\n').filter(path => Boolean(path) && path !== `${out}/resume.measure.ts`).sort();
  const sourceFingerprint = sha(JSON.stringify(paths.map(p => [p, sha(readFileSync(p))])));
  expect(sourceFingerprint, 'Every original source file must match; only the new recovery runner is excluded').toBe(original.sourceFingerprint);
  const provenance = {
    startedAt: original.startedAt, commit: original.commit, datasetSha256: original.datasetSha256,
    sourceFingerprint, seeds, lane: 'quick', calls: 0, resumed: true,
    resumedAt: new Date().toISOString(), resumedCommit: git('rev-parse', 'HEAD'),
    recoveryRunnerSha256: sha(readFileSync(`${out}/resume.measure.ts`)),
    originalResult: 'evals/play/p42/round2/final.json', originalResultSha256: sha(originalBytes),
    originalSourceFingerprint: original.sourceFingerprint, completedBeforeInterruption: 47,
    preservedPrefixSha256, unpersistedAttempts: 'Unknown; the 48th observation may have been attempted before checkpoint failure.',
    interruption: 'Original runner aborted in checkpoint save/writeFileSync. The OS error code was not retained; a transient Windows sharing error is suspected, not established.',
    protocolLimitation: 'Resumed measurement, not a complete uninterrupted one-shot run. The first 47 observations and their original latency values are preserved; unpersisted attempts and process restart may affect timing comparability.',
  };
  const rows: Row[] = [...original.rows];
  vi.stubEnv('PLAY_READER', 'off');
  try {
    const prepared = await prepareDrafting(loadRapier, draftGameSpecWithMeta);
    save('final-resumed.json', { ...provenance, state: 'in-progress', rows }, true);
    console.log(JSON.stringify({ recovery: 'started', preservedRows: rows.length, total: planned.length }));
    for (const { label, seed } of planned.slice(original.rows.length)) {
      const start = performance.now();
      try {
        const draft = prepared.draft(label.sentence, seed), milliseconds = performance.now() - start;
        await preloadPhysics(draft.spec, loadRapier);
        const made = arcadeWorldOf(draft.spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const verdict = verifyArcade(made.world, undefined, made.roleBindings);
        const honesty = await honestyForSpec(label.sentence, draft.spec, seed, made.world);
        const unmet = honesty?.unmet ?? [];
        rows.push({ id: label.id, sentence: label.sentence, seed, milliseconds, spec: draft.spec, specHash: gameSpecHash(draft.spec), worldHash: sha(JSON.stringify(made.world)), built: verdict.publishEligible && verdict.replayEqual,
          witnesses: verdict.witnesses, honesty,
          score: scoreTriples(label.essential, verdict.witnesses, unmet, { unsupported: label.unsupported, visibleAdmission: Boolean(honesty?.reason.trim()) }),
          hero: label.hero === null ? null : draft.spec.roles.some(r => r.kind === 'player' && norm(r.label) === norm(label.hero!)),
          environment: label.setting === null ? null : sameEnvironment(draft.spec.theme.setting, label.setting),
          verification: { outcome: verdict.bot.outcome, tick: verdict.bot.tick, hash: verdict.bot.hash, replayEqual: verdict.replayEqual, publishEligible: verdict.publishEligible, failures: verdict.failures }, error: null });
      } catch (error) {
        rows.push({ id: label.id, sentence: label.sentence, seed, milliseconds: performance.now() - start, built: false, score: scoreTriples(label.essential, []), hero: label.hero === null ? null : false, environment: label.setting === null ? null : false, error: String(error) });
      }
      save('final-resumed.json', { ...provenance, state: 'in-progress', rows });
      if (rows.length % 40 === 0) console.log(JSON.stringify({ recovery: 'progress', completedRows: rows.length, total: planned.length }));
    }
    expect(rows).toHaveLength(320);
    expect(sha(JSON.stringify(rows.slice(0, 47)))).toBe(preservedPrefixSha256);
    expect(sha(readFileSync(`${out}/final.json`))).toBe(provenance.originalResultSha256);
    let golden = false;
    try {
      const log = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'evals/play/p41/__tests__/golden.test.ts', '--maxWorkers=1'], { timeout: 600_000, encoding: 'utf8', stdio: 'pipe' });
      retryWrite(`${out}/golden-resumed.log`, log); golden = true;
    } catch (error) { retryWrite(`${out}/golden-resumed.log`, String(error)); }
    const allSeeds = labels.filter(l => rows.filter(r => r.id === l.id).every(r => r.built && r.score.preserved)).length;
    const hero = rows.filter(r => r.hero !== null), environment = rows.filter(r => r.environment !== null);
    const times = rows.map(r => r.milliseconds).sort((a, b) => a - b);
    const summary = { planned: 320, measured: rows.length, preservedSentences: allSeeds, preservedSentenceAllSeedsRate: allSeeds / 64,
      preservedRunRate: rows.filter(r => r.built && r.score.preserved).length / rows.length, buildRate: rows.filter(r => r.built).length / rows.length,
      heroRate: hero.filter(r => r.hero).length / hero.length, heroApplicable: hero.length,
      environmentRate: environment.filter(r => r.environment).length / environment.length, environmentApplicable: environment.length,
      silentTriples: rows.reduce((n, r) => n + (r.built ? r.score.silent.length : 0), 0), p95ms: times[Math.ceil(times.length * .95) - 1]!, golden };
    const targets = { preservation: summary.preservedSentenceAllSeedsRate >= .8, silence: summary.silentTriples === 0, environment: summary.environmentRate >= .9, hero: summary.heroRate >= .9, latency: summary.p95ms <= 2000, golden };
    save('final-resumed.json', { ...provenance, finishedAt: new Date().toISOString(), state: 'measured', summary, targets, rows });
    retryWrite(`${out}/final-resumed.md`, `# P42 round2 resumed measurement\n\nOperational recovery after a checkpoint write failure. Original final.json is preserved. The first 47 rows and their latencies are unchanged; a possible unpersisted 48th attempt is unknown. This is not a complete uninterrupted one-shot run.\n\n${Object.values(targets).every(Boolean) ? 'PASS' : 'FAIL'}\n\n` + Object.entries(summary).map(([k,v]) => `- ${k}: ${v}`).join('\n') + '\n\nFailures and all witnesses: final-resumed.json. Golden log: golden-resumed.log. Human play is a separate required check; this report does not claim it occurred.\n');
    console.log(JSON.stringify({ summary, targets }));
    expect(targets).toEqual({ preservation: true, silence: true, environment: true, hero: true, latency: true, golden: true });
  } finally { vi.unstubAllEnvs(); }
});
