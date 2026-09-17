/** Local P19 archive replay only; never reports a new model-generation result. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import { expect, it } from 'vitest';
import { compileBlueprint } from '@/model/worldstream-compiler';
import { readPlannerEmission } from '@/model/worldstream-intent';
import type { UpstreamRequest } from '@/model/prompt';
import { readQualityCases } from './corpus';

it('replays every P19 case, retaining failures and every compiler attempt', () => {
  const root = resolve(process.env.P20_RUN_DIR ?? 'plans/P20/baseline-replay');
  mkdirSync(root, { recursive: false }); // Refuse to overwrite historical evidence.
  const archive = resolve(process.env.P20_ARCHIVE_DIR ?? 'plans/P19/answers-after');
  const files = readdirSync(archive).filter((f) => /-\d+\.json$/.test(f));
  type Archived = { request: UpstreamRequest; answer: unknown };
  const read = (file: string): Archived => JSON.parse(readFileSync(join(archive, file), 'utf8'));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();
  const environment = {
    kind: 'archive-replay', measuredAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'),
    dirtyDiffHash: hash(git('diff', 'HEAD')), node: process.version, os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model, gpu: null, browser: null, liveGeneration: 'pending', sessionSeed: 1,
    seedReason: 'P19 archived compiler replay used seed 1; new live runs use protocol seed 4021.',
  };
  writeFileSync(join(root, 'environment.json'), JSON.stringify(environment, null, 2));
  mkdirSync(join(root, 'replay'));
  const rows = [];
  for (const entry of readQualityCases('development')) {
    const first = files.find((f) => /-1\.json$/.test(f) && read(f).request.user.includes(entry.prompt));
    if (!first) { rows.push({ id: entry.id, failure: 'missing archive', attempts: [] }); continue; }
    const prefix = first.replace(/-1\.json$/, '');
    const calls = files.filter((f) => f.startsWith(`${prefix}-`)).sort((a, b) => Number(/-(\d+)\.json$/.exec(a)![1]) - Number(/-(\d+)\.json$/.exec(b)![1]));
    const planner = readPlannerEmission(read(first).answer);
    const attempts = [];
    let blueprint = null;
    for (const file of calls.filter((f) => f !== first)) {
      const saved = read(file);
      const start = performance.now();
      const result = planner.ok ? compileBlueprint(saved.answer, planner.value, { sessionSeed: 1, upstream: saved.request }) : planner;
      attempts.push({ file, sha256: hash(readFileSync(join(archive, file), 'utf8')), ms: performance.now() - start, ok: result.ok, failure: result.ok ? null : result });
      if (result.ok) blueprint = result.value;
    }
    const row = { id: entry.id, planner: first, plannerHash: hash(readFileSync(join(archive, first), 'utf8')), attempts, compiled: blueprint !== null };
    rows.push(row);
    writeFileSync(join(root, 'results.json'), JSON.stringify(rows, null, 2));
    if (blueprint !== null) writeFileSync(join(root, 'replay', `${entry.id}.json`), JSON.stringify({ id: entry.id, prompt: entry.prompt, model: 'P19 archived answers / current compiler', blueprint }, null, 2));
  }
  writeFileSync(join(root, 'results.json'), JSON.stringify(rows, null, 2));
  expect(rows).toHaveLength(10);
}, 600_000);
