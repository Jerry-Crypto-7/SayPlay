/** T32 only. Do not import/run this file while tuning on the development set. */
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness, type ActionWitness } from '@/play/arcade/witness';
import { draftGameSpecWithMeta } from '@/play/draft';
import { direct } from '@/play/director';
import { gameSpecHash, type GameSpecV1 } from '@/play/spec';
import type { IntentTriple } from '@/play/intent/contract';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { scoreTriples } from './score';
import { prepareDrafting } from './after-harness';

type Label = { id: string; sentence: string; hero: string | null; setting: string | null; essential: IntentTriple[] };
type Frozen = { id: string; seed: number; spec?: GameSpecV1; milliseconds?: number; error?: string; honesty?: unknown };
type Row = {
  id: string; seed: number; lane: 'baseline' | 'quick' | 'director'; sentence: string;
  spec: GameSpecV1 | null; specHash: string | null; milliseconds: number | null;
  worldHash: string | null; built: boolean; witnesses: readonly ActionWitness[];
  score: ReturnType<typeof scoreTriples>; hero: boolean | null; environment: boolean | null;
  error: string | null; missingMeasurement: string | null; verification: unknown;
  source?: string; calls?: number; fallbackReason?: string | null; failure?: unknown;
  unchangedSpec?: boolean; unchangedWorld?: boolean; actionLoss?: IntentTriple[];
  legacyNotice?: unknown;
};
type Golden = { passed: boolean; log: string };
type BaselineProvenance = {
  guard: 'passed'; sourceCount: number; sourceManifestSha256: string; bundleSha256: string;
  sources: { path: string; sha256: string }[]; externals: string[];
};
const SEEDS = [1, 2, 3, 4, 5], DIRECTOR_SEEDS = [1, 2, 3];
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const ratio = (n: number, d: number) => d === 0 ? null : n / d;
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const json = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();

async function observe(label: Label, lane: Row['lane'], seed: number, spec: GameSpecV1 | null, milliseconds: number | null, unmet: readonly IntentTriple[] = [], error: string | null = null): Promise<Row> {
  let witnesses: readonly ActionWitness[] = [], built = false, verification: unknown = null, worldHash: string | null = null;
  if (spec !== null) try {
    await preloadPhysics(spec, loadRapier);
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    worldHash = sha(JSON.stringify(made.world));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    witnesses = verdict.witnesses;
    built = verdict.publishEligible && verdict.replayEqual;
    verification = { outcome: verdict.bot.outcome, tick: verdict.bot.tick, hash: verdict.bot.hash, replayEqual: verdict.replayEqual, publishEligible: verdict.publishEligible, failures: verdict.failures };
  } catch (failure) { error = String(failure); }
  return { id: label.id, sentence: label.sentence, lane, seed, spec, specHash: spec === null ? null : gameSpecHash(spec), milliseconds, worldHash, built: built && error === null, witnesses,
    score: scoreTriples(label.essential, witnesses, unmet),
    hero: label.hero === null ? null : spec?.roles.some(role => role.kind === 'player' && normalize(role.label) === normalize(label.hero!)) === true,
    environment: label.setting === null ? null : spec !== null && normalize(spec.theme.setting) === normalize(label.setting),
    error, missingMeasurement: null, verification };
}

// Failed director attempts remain measured, but quick fallback is not AI output.
const hasLaneOutput = (row: Row) => row.lane !== 'director' || row.source === 'authored';

function summarize(rows: readonly Row[]) {
  const measured = rows.filter(row => row.missingMeasurement === null);
  const times = measured.flatMap(row => row.milliseconds === null ? [] : [row.milliseconds]).sort((a, b) => a - b);
  const ids = [...new Set(rows.map(row => row.id))];
  const allSeeds = ids.filter(id => rows.filter(row => row.id === id).every(row => row.missingMeasurement === null && hasLaneOutput(row) && row.built && row.score.preserved));
  const namedHero = measured.filter(row => row.hero !== null), namedEnvironment = measured.filter(row => row.environment !== null);
  return { planned: rows.length, measured: measured.length, missingMeasurements: rows.length - measured.length,
    preservedRunRate: ratio(measured.filter(row => hasLaneOutput(row) && row.built && row.score.preserved).length, measured.length),
    preservedSentenceAllSeedsRate: measured.length === rows.length ? ratio(allSeeds.length, ids.length) : null,
    buildRate: ratio(measured.filter(row => hasLaneOutput(row) && row.built).length, measured.length),
    fallbackRuns: measured.filter(row => !hasLaneOutput(row)).length,
    heroRate: ratio(namedHero.filter(row => hasLaneOutput(row) && row.hero).length, namedHero.length), heroApplicable: namedHero.length,
    environmentRate: ratio(namedEnvironment.filter(row => hasLaneOutput(row) && row.environment).length, namedEnvironment.length), environmentApplicable: namedEnvironment.length,
    // A failed build is not a published silent omission; it still fails both
    // build and preservation rates and remains in the complete failure list.
    silentTriples: measured.length > 0 && measured.length === rows.length ? measured.reduce((n, row) => n + (hasLaneOutput(row) && row.built ? row.score.silent.length : 0), 0) : null,
    p95ms: times.length === 0 ? null : times[Math.ceil(times.length * .95) - 1]!,
    missing: measured.filter(row => !hasLaneOutput(row) || !row.built || !row.score.preserved || row.hero === false || row.environment === false).map(row => ({ id: row.id, seed: row.seed, source: row.source, fallbackReason: row.fallbackReason, missing: row.score.missing, silent: row.score.silent, hero: row.hero, environment: row.environment, error: row.error, verification: row.verification })) };
}


type BlindKey = { pairId: string; aiSide: 'A' | 'B' };
type BlindPair = { pairId: string; sentence: string; seed: number; A: GameSpecV1 | null; B: GameSpecV1 | null };
type DirectorBatch = { startedAt: string; finishedAt: string | null; commit: string; resume: boolean; liveAuthorized: boolean; callCap: number | null; calls: number };
const pendingDirector = (row: Row): boolean => row.lane === 'director' && row.missingMeasurement !== null;
const canStartDirector = (batchCalls: number, cap: number): boolean => batchCalls + 3 <= cap;
function checkContinuationMode(reviewOnly: boolean, resumeDirector: boolean, liveAuthorized: boolean): void {
  if (reviewOnly && resumeDirector) throw new Error('REVIEW_ONLY and RESUME_DIRECTOR are mutually exclusive');
  if (resumeDirector && !liveAuthorized) throw new Error('RESUME_DIRECTOR still requires explicit P41_FINAL_LIVE_DIRECTOR=1 authorization');
}
function storeDirectorRow(rows: Row[], row: Row): void {
  if (row.lane !== 'director') throw new Error('Director batches cannot replace baseline or quick rows');
  const index = rows.findIndex(old => old.lane === 'director' && old.id === row.id && old.seed === row.seed);
  if (index < 0) rows.push(row);
  else {
    if (!pendingDirector(rows[index]!)) throw new Error('An observed director result cannot be retried');
    rows[index] = row;
  }
}
function retainedBlindPairs(rows: readonly Row[], pairs: readonly BlindPair[], key: readonly BlindKey[], datasetHash: string): void {
  const offered = rows.filter(row => row.lane === 'director' && row.missingMeasurement === null && row.source === 'authored' && row.fallbackReason === null && row.built && row.actionLoss?.length === 0);
  if (pairs.length !== offered.length || new Set(pairs.map(pair => pair.pairId)).size !== pairs.length) throw new Error('Incomplete or duplicate original blind pairs');
  for (const row of offered) {
    const quick = rows.find(q => q.lane === 'quick' && q.id === row.id && q.seed === row.seed);
    if (quick === undefined) throw new Error('Original blind pair has no quick result');
    const pairId = sha(`${datasetHash}/${row.id}/${row.seed}/${quick.specHash}/${row.specHash}`);
    const keys = key.filter(item => item.pairId === pairId);
    if (keys.length !== 1 || !['A', 'B'].includes(keys[0]!.aiSide)) throw new Error('Original blind key missing or invalid; no director batch may start');
    const side = keys[0]!.aiSide;
    const expected = { pairId, sentence: row.sentence, seed: row.seed, A: side === 'A' ? row.spec : quick.spec, B: side === 'B' ? row.spec : quick.spec };
    const saved = pairs.find(pair => pair.pairId === pairId);
    if (saved === undefined || sha(JSON.stringify(saved)) !== sha(JSON.stringify(expected))) throw new Error('Original blind pairs/key do not match measured results');
  }
}

it('T32 sealed held-out baseline, quick, subscription director and honest missing measurements', async () => {
  // Explicit operational guard prevents an exploratory invocation from opening the set.
  if (process.env.P41_FINAL_OPEN_HELD_OUT !== '1') throw new Error('T32 only: set P41_FINAL_OPEN_HELD_OUT=1 after freezing implementation and all tuning.');
  const reviewOnly = process.env.P41_FINAL_REVIEW_ONLY === '1', resumeDirector = process.env.P41_FINAL_RESUME_DIRECTOR === '1';
  const liveAuthorized = process.env.P41_FINAL_LIVE_DIRECTOR === '1';
  checkContinuationMode(reviewOnly, resumeDirector, liveAuthorized);
  const out = 'evals/play/p41', scratch = '.claude/scratchpads';
  const keyPath = join(scratch, 'p41-final-blind-key.json');
  const priorKey = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) as BlindKey[] : [];
  let priorPairs: BlindPair[] = [];
  const directorBatches: DirectorBatch[] = [];
  mkdirSync(scratch, { recursive: true });
  const labels = (JSON.parse(readFileSync(`${out}/sentences.json`, 'utf8')) as { groups: Record<string, Label[]> }).groups['held-out']!;
  expect(labels).toHaveLength(64);
  expect(new Set(labels.map(label => label.id)).size).toBe(64);
  const startedAt = new Date().toISOString(), commit = git('rev-parse', 'HEAD');
  const treeDiffHash = sha(git('diff', 'HEAD', '--', 'src', 'scripts/p41', 'evals/play/p41/*.ts'));
  // Hash source bytes, including untracked source; report-only commits are harmless.
  const sourcePaths = git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts/p41', 'evals/play/p41/*.ts', 'evals/play/p41/__tests__/*.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.mts', 'vitest.measure.mts').split('\n').filter(Boolean).sort();
  const sourceFingerprint = sha(JSON.stringify(sourcePaths.map(path => [path, sha(readFileSync(path))])));
  let measurementCommit = commit, measurementTreeDiffHash = treeDiffHash, measurementStartedAt = startedAt, measurementFinishedAt: string | null = null;
  const datasetHash = sha(JSON.stringify(labels)), rows: Row[] = [];
  const externalLimits: { id: string | null; seed: number | null; reason: string }[] = [];
  const missingMeasurements: string[] = [];
  type Baseline = { commit: string; lockSha256: string; provenance: BaselineProvenance; seeds: number[]; rows: Frozen[] };
  let baseline: Baseline | null = null;
  let golden: Golden | null = null;
  let calls = 0;
  const checkpoint = () => json(`${out}/final.json`, { version: 1, state: 'in-progress', startedAt: measurementStartedAt, commit: measurementCommit, treeDiffHash: measurementTreeDiffHash, sourceFingerprint, datasetHash, seeds: SEEDS, directorSeeds: DIRECTOR_SEEDS, baselineCommit: baseline?.commit, lockSha256: baseline?.lockSha256, baselineProvenance: baseline?.provenance ?? null, calls, directorBatches, golden, externalLimits, missingMeasurements, rows });
  vi.stubEnv('PLAY_READER', 'off'); // No implicit model transport besides the branch below.
  try {
    // Complete the human protocol without repeating held-out generations/model calls.
    if (reviewOnly || resumeDirector) {
      const previous = JSON.parse(readFileSync(`${out}/final.json`, 'utf8')) as { state: string; commit: string; treeDiffHash: string; sourceFingerprint: string; startedAt: string; finishedAt: string; datasetHash: string; rows: Row[]; baselineCommit: string; lockSha256: string; baselineProvenance: BaselineProvenance; calls: number; directorBatches?: DirectorBatch[]; golden: Golden | null; externalLimits: typeof externalLimits; missingMeasurements: string[] };
      if (previous.state !== 'measured' || previous.sourceFingerprint !== sourceFingerprint || previous.datasetHash !== datasetHash) throw new Error('Continuation requires a completed report with the exact frozen source fingerprint and dataset');
      measurementCommit = previous.commit; measurementTreeDiffHash = previous.treeDiffHash; measurementStartedAt = previous.startedAt; measurementFinishedAt = previous.finishedAt;
      for (const lane of ['baseline', 'quick', 'director'] as const) {
        const seeds = lane === 'director' ? DIRECTOR_SEEDS : SEEDS;
        expect(previous.rows.filter(row => row.lane === lane).map(row => `${row.id}/${row.seed}`).sort()).toEqual(labels.flatMap(label => seeds.map(seed => `${label.id}/${seed}`)).sort());
      }
      const savedPairs = JSON.parse(readFileSync(`${out}/final-blind-pairs.json`, 'utf8')) as { protocol: string; pairs: BlindPair[] };
      if (savedPairs.protocol !== 'human-blind-v1') throw new Error('Invalid original blind protocol');
      retainedBlindPairs(previous.rows, savedPairs.pairs, priorKey, datasetHash);
      priorPairs = savedPairs.pairs;
      rows.push(...previous.rows); calls = previous.calls; golden = previous.golden;
      directorBatches.push(...(previous.directorBatches ?? []));
      externalLimits.push(...previous.externalLimits);
      missingMeasurements.push(...previous.missingMeasurements.filter(reason => resumeDirector
        ? reason.startsWith('Frozen baseline unavailable:') || reason.startsWith('Quick drafting startup:')
        : !reason.startsWith('Human blind comparison')));
      baseline = { commit: previous.baselineCommit, lockSha256: previous.lockSha256, provenance: previous.baselineProvenance, seeds: SEEDS, rows: [] };
    } else {
    const input = join(scratch, 'p41-final-base-input.json'), output = join(scratch, 'p41-final-base-drafts.json');
    json(input, labels.map(({ id, sentence }) => ({ id, sentence })));
    try {
      execFileSync(process.execPath, ['scripts/p41/base-drafts.mjs', input, output], { timeout: 600_000, stdio: 'pipe' });
      baseline = JSON.parse(readFileSync(output, 'utf8')) as Baseline;
      expect(baseline.seeds).toEqual(SEEDS);
      expect(baseline.rows).toHaveLength(64 * 5);
      expect(baseline.commit).toBe(git('rev-parse', 'p41-base^{commit}'));
      expect(baseline.lockSha256).toBe(sha(readFileSync('package-lock.json', 'utf8')));
      expect(baseline.provenance.guard).toBe('passed');
      expect(baseline.provenance.sourceCount).toBe(baseline.provenance.sources.length);
      expect(baseline.provenance.sourceCount).toBeGreaterThan(1);
      expect(baseline.provenance.sourceManifestSha256).toBe(sha(JSON.stringify(baseline.provenance.sources)));
      expect(baseline.rows.map(row => `${row.id}/${row.seed}`).sort()).toEqual(labels.flatMap(label => SEEDS.map(seed => `${label.id}/${seed}`)).sort());
    } catch (error) { baseline = null; missingMeasurements.push(`Frozen baseline unavailable: ${String(error)}`); }
    const prepared = await prepareDrafting(loadRapier, draftGameSpecWithMeta);
    if (prepared.startupError !== null) missingMeasurements.push(`Quick drafting startup: ${prepared.startupError}`);
    for (const label of labels) for (const seed of SEEDS) {
      const old = baseline?.rows.find(row => row.id === label.id && row.seed === seed);
      const oldRow = await observe(label, 'baseline', seed, old?.spec ?? null, old?.milliseconds ?? null, [], old?.error ?? null);
      oldRow.legacyNotice = old?.honesty ?? null;
      if (baseline === null || old === undefined) oldRow.missingMeasurement = 'Frozen baseline draft unavailable';
      rows.push(oldRow);
      const start = performance.now();
      try {
        const draft = prepared.draft(label.sentence, seed), ms = performance.now() - start;
        const row = await observe(label, 'quick', seed, draft.spec, ms, draft.composition?.unmet ?? []);
        row.unchangedSpec = oldRow.specHash !== null && row.specHash === oldRow.specHash;
        row.unchangedWorld = oldRow.worldHash !== null && row.worldHash === oldRow.worldHash;
        rows.push(row);
      } catch (error) { rows.push(await observe(label, 'quick', seed, null, performance.now() - start, [], String(error))); }
      checkpoint();
    }
    }
    if (!reviewOnly) {
    const config = upstreamConfigFromEnv({ ...process.env, WORLDSMITH_MODEL_ENDPOINT: 'codex-cli', WORLDSMITH_MODEL_PROFILE: 'subscription', WORLDSMITH_MODEL: 'gpt-6-astra', WORLDSMITH_MODEL_EFFORT: 'medium', WORLDSMITH_FALLBACK_ENDPOINT: '' });
    // Keep local held-out measurement independent of the separately authorized
    // external payload. Set this only after consent for the held-out transmissions.
    const usable = liveAuthorized && config !== null && config.endpoint === 'codex-cli' && config.profile === 'subscription' && config.callCap !== null;
    // Removing fallback is explicit even if a future config parser adds one.
    const batch: DirectorBatch = { startedAt: new Date().toISOString(), finishedAt: null, commit, resume: resumeDirector, liveAuthorized, callCap: config?.callCap ?? null, calls: 0 };
    directorBatches.push(batch);
    const branch = usable && (!resumeDirector || rows.some(pendingDirector)) ? upstreamBranch({ ...config!, fallback: undefined }) : null;
    const branchBlock = !liveAuthorized ? 'Held-out director transmission not authorized; no external call attempted' : 'codex-cli subscription configuration unavailable; no API fallback attempted';
    for (const label of labels) for (const seed of DIRECTOR_SEEDS) {
      const prior = rows.find(row => row.lane === 'director' && row.id === label.id && row.seed === seed);
      if (resumeDirector && prior !== undefined && !pendingDirector(prior)) continue;
      const quick = rows.find(row => row.lane === 'quick' && row.id === label.id && row.seed === seed)!;
      const blocked = branch === null ? branchBlock : !canStartDirector(batch.calls, config!.callCap!) ? 'subscription call cap cannot reserve answer + two repair calls' : null;
      if (blocked !== null) {
        const row = await observe(label, 'director', seed, null, null);
        row.missingMeasurement = blocked; storeDirectorRow(rows, row); externalLimits.push({ id: label.id, seed, reason: blocked }); checkpoint(); continue;
      }
      const start = performance.now();
      try {
        const game = await direct(label.sentence, { branch: branch!, seed, now: () => performance.now(), maxRepairRounds: 2 });
        calls += game.calls; batch.calls += game.calls;
        const row = await observe(label, 'director', seed, game.spec, performance.now() - start, game.unmet ?? []);
        Object.assign(row, { source: game.source, calls: game.calls, fallbackReason: game.fallbackReason, failure: game.failure ?? null,
          unchangedSpec: row.specHash === quick.specHash, unchangedWorld: row.worldHash !== null && row.worldHash === quick.worldHash,
          actionLoss: label.essential.filter(triple => quick.witnesses.some(w => matchesWitness(triple, w)) && !row.witnesses.some(w => matchesWitness(triple, w))) });
        if (game.fallbackReason === 'MODEL_UNAVAILABLE') {
          row.missingMeasurement = 'Actual director transport unavailable; returned quick fallback is not an AI observation';
          externalLimits.push({ id: label.id, seed, reason: game.failure?.reason ?? 'MODEL_UNAVAILABLE' });
        }
        storeDirectorRow(rows, row);
      } catch (error) {
        calls += 3; batch.calls += 3; // Conservative reservation after an exception with no call count.
        const row = await observe(label, 'director', seed, null, performance.now() - start, [], String(error));
        row.missingMeasurement = 'Director execution threw before an observable result'; storeDirectorRow(rows, row);
        externalLimits.push({ id: label.id, seed, reason: String(error) });
      }
      checkpoint();
    }
    batch.finishedAt = new Date().toISOString();
    missingMeasurements.push(...new Set(rows.filter(pendingDirector).map(row => row.missingMeasurement!)));
    }
    const summaries = Object.fromEntries((['baseline', 'quick', 'director'] as const).map(lane => [lane, summarize(rows.filter(row => row.lane === lane))]));
    const ai = rows.filter(row => row.lane === 'director' && row.missingMeasurement === null);
    const offered = ai.filter(row => row.source === 'authored' && row.fallbackReason === null && row.built && row.actionLoss?.length === 0);
    const key: BlindKey[] = [];
    const candidatePairs = offered.map(row => {
      const quick = rows.find(q => q.lane === 'quick' && q.id === row.id && q.seed === row.seed)!;
      const pairId = sha(`${datasetHash}/${row.id}/${row.seed}/${quick.specHash}/${row.specHash}`);
      const existing = priorKey.filter(item => item.pairId === pairId);
      if (existing.length > 1 || existing.some(item => !['A', 'B'].includes(item.aiSide)) || (reviewOnly || resumeDirector && priorPairs.some(pair => pair.pairId === pairId)) && existing.length !== 1) throw new Error('Blind A/B key missing or invalid; preserve the original key and pair order before reviewing');
      const aiSide = existing[0]?.aiSide ?? (randomInt(2) === 0 ? 'A' : 'B'); key.push({ pairId, aiSide });
      return { pairId, sentence: row.sentence, seed: row.seed, A: aiSide === 'A' ? row.spec : quick.spec, B: aiSide === 'B' ? row.spec : quick.spec };
    });
    const retainedIds = new Set(priorPairs.map(pair => pair.pairId));
    const pairs = reviewOnly || resumeDirector ? [...priorPairs, ...candidatePairs.filter(pair => !retainedIds.has(pair.pairId))] : candidatePairs;
    if (reviewOnly || resumeDirector) {
      const orderedKey = [...priorKey.filter(item => retainedIds.has(item.pairId)), ...key.filter(item => !retainedIds.has(item.pairId))];
      key.splice(0, key.length, ...orderedKey);
    }
    if (reviewOnly) {
      const previousPairs = JSON.parse(readFileSync(`${out}/final-blind-pairs.json`, 'utf8')) as { protocol: string; pairs: unknown };
      if (previousPairs.protocol !== 'human-blind-v1' || sha(JSON.stringify(previousPairs.pairs)) !== sha(JSON.stringify(pairs))) throw new Error('Blind key does not reproduce the original A/B pairs; ratings cannot be reused');
    }
    // Human plays both versions, hidden order. No automated proxy claims a blind win.
    json(`${out}/final-blind-pairs.json`, { protocol: 'human-blind-v1', pairs });
    json(keyPath, key);
    const ratingsPath = process.env.P41_BLIND_RATINGS;
    let blindWinRate: number | null = null, blindRated = 0;
    if (ratingsPath !== undefined && existsSync(ratingsPath)) {
      const rated = JSON.parse(readFileSync(ratingsPath, 'utf8')) as { protocol: string; reviewer: string; ratings: { pairId: string; winner: 'A' | 'B' | 'tie' }[] };
      if (rated.protocol !== 'human-blind-v1' || !rated.reviewer?.trim() || new Set(rated.ratings.map(r => r.pairId)).size !== rated.ratings.length || rated.ratings.some(r => !key.some(k => k.pairId === r.pairId) || !['A', 'B', 'tie'].includes(r.winner))) throw new Error('Invalid/stale blind-rating protocol; no win rate may be inferred');
      blindRated = rated.ratings.length;
      if (blindRated === offered.length && blindRated > 0) blindWinRate = rated.ratings.filter(r => key.find(k => k.pairId === r.pairId)!.aiSide === r.winner).length / offered.length;
    }
    if (blindWinRate === null) missingMeasurements.push(`Human blind comparison missing/incomplete: ${blindRated}/${offered.length}; ties must remain in denominator`);
    const goldenLog = join(scratch, 'p41-final-golden.log');
    if (golden === null) try {
      const output = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'evals/play/p41/__tests__/golden.test.ts', '--maxWorkers=1'], { timeout: 600_000, encoding: 'utf8', stdio: 'pipe' });
      writeFileSync(goldenLog, output); golden = { passed: true, log: goldenLog };
    } catch (error) { writeFileSync(goldenLog, String(error)); golden = { passed: false, log: goldenLog }; }
    const completeAI = ai.length === labels.length * DIRECTOR_SEEDS.length;
    const actionLossRate = completeAI ? ratio(ai.filter(row => (row.actionLoss?.length ?? 0) > 0).length, ai.length) : null;
    const target = (name: string, actual: number | null, threshold: number, direction: 'min' | 'max') => ({ name, actual, threshold, direction, status: actual === null ? 'missing-measurement' : (direction === 'min' ? actual >= threshold : actual <= threshold) ? 'pass' : 'finding' });
    const q = summaries.quick!;
    const targets = [target('essential sentences, all five seeds', q.preservedSentenceAllSeedsRate, .8, 'min'), target('hero', q.heroRate, .9, 'min'), target('environment', q.environmentRate, .9, 'min'), target('silent omissions', q.silentTriples, 0, 'max'), target('build/replay rate', q.buildRate, .95, 'min'), target('quick p95 milliseconds', q.p95ms, 2000, 'max'), target('AI blind wins, ties included', blindWinRate, .7, 'min'), target('AI loses a previously witnessed action', actionLossRate, .05, 'max')];
    const report = { version: 1, state: 'measured', startedAt: measurementStartedAt, finishedAt: measurementFinishedAt ?? new Date().toISOString(), commit: measurementCommit, treeDiffHash: measurementTreeDiffHash, sourceFingerprint, datasetHash,
      ...(reviewOnly ? { reviewedAt: new Date().toISOString(), reviewCommit: commit } : {}),
      ...(resumeDirector ? { directorResumedAt: new Date().toISOString(), directorResumeCommit: commit } : {}), baselineCommit: baseline?.commit ?? null, lockSha256: baseline?.lockSha256 ?? null, baselineProvenance: baseline?.provenance ?? null,
      seeds: SEEDS, directorSeeds: DIRECTOR_SEEDS, transport: 'codex-cli', model: 'gpt-6-astra', effort: 'medium', calls, directorBatches, summaries, targets, golden,
      blind: { offered: offered.length, rated: blindRated, winRate: blindWinRate, pairsArtifact: `${out}/final-blind-pairs.json` }, actionLossRate, externalLimits, missingMeasurements,
      unchanged: rows.filter(row => row.unchangedSpec || row.unchangedWorld).map(row => ({ lane: row.lane, id: row.id, seed: row.seed, unchangedSpec: row.unchangedSpec, unchangedWorld: row.unchangedWorld })), rows,
      notes: ['Admissions never count as preserved actions.', 'Observed director failures returning quick fallback remain measured failures, not successful AI outputs; unavailable transport remains missing.', 'Frozen specs use the current witness/runtime seam, as in T5; golden replay test independently detects runtime drift.', 'Hero/environment require exact normalized hand-label match; null labels are excluded with applicability counts.', 'Primary preservation denominator is sentences preserved on all five seeds; per-run rates are also reported.', 'No blind ratings are fabricated, and no paid transport fallback is used.', 'Director resume retries only missing measurements; observed failed attempts remain fixed. Calls are cumulative, with a separate cap and call count for each explicit batch.'] };
    json(`${out}/final.json`, report);
    const failures = rows.filter(row => row.missingMeasurement !== null || row.error !== null || !hasLaneOutput(row) || !row.built || !row.score.preserved || row.hero === false || row.environment === false);
    writeFileSync(`${out}/final.md`, `# P41 final measurement\n\nCommit: ${measurementCommit}; baseline: ${baseline?.commit ?? 'MISSING'}.\n\n` +
      targets.map(t => `- ${t.name}: ${t.actual ?? 'MISSING'}; ${t.direction} ${t.threshold}; **${t.status}**`).join('\n') +
      `\n- Golden replay: ${golden.passed ? 'PASS' : 'FAIL'} (${golden.log})\n\n## Missing measurements\n\n${missingMeasurements.join('\n') || 'None'}\n\n## Every failure or omission\n\n` +
      failures.map(row => `- ${row.lane}/${row.id}/${row.seed}: ${JSON.stringify({ source: row.source, fallbackReason: row.fallbackReason, missing: row.score.missing, silent: row.score.silent, hero: row.hero, environment: row.environment, error: row.error, missingMeasurement: row.missingMeasurement, verification: row.verification })}`).join('\n') +
      `\n\n## Every unchanged result (quick vs baseline; AI vs quick)\n\n${report.unchanged.map(row => `- ${JSON.stringify(row)}`).join('\n') || 'None'}\n`);
    console.log(JSON.stringify({ targets, golden, externalLimits: externalLimits.length, missingMeasurements }));
    expect(rows.filter(row => row.lane === 'quick')).toHaveLength(320);
    expect(rows.filter(row => row.lane === 'director')).toHaveLength(192);
    // Targets remain numbers in the report, never tuned into passing thresholds.
  } finally { vi.unstubAllEnvs(); }
}, 24 * 60 * 60_000);
