/**
* Historical 40 corpus, current P41 sentence composition. P41 intentionally changes
* selection and opts into calibrated recipes. Original report.json/report.md stay
* untouched; exact frozen P41 worlds/replays remain a separate strict oracle.
* Each extracted essential triple needs an actual witness or explicit production
* admission. Admission is a preservation failure, never a preservation success.
* Old genreHits 26 remains a diagnostic target, not a silently replaced target.
* This does not certify unextracted count/order/fragility/remix clauses, replace
* manual training 70%/T32 targets, or assert all 40 sentences are preserved.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { compileGame } from '@/play/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { actionEvidence, missingActions } from '@/play/fidelity/action-evidence';
import { essentialTriples, type IntentTriple } from '@/play/intent/contract';
import { readGameSpec } from '@/play/spec';
import { reportFor } from '@/app/api/play/_report';

import { goldenPrompts } from '../golden';

const ARTIFACT = fileURLToPath(new URL('./report.json', import.meta.url));
const TABLE = fileURLToPath(new URL('./report.md', import.meta.url));
const SEED = 1;
const PIN = {
  specValid: 40,
  compiled: 40,
  eligible: 40,
  genreHits: 26,
} as const;
const P90_COMPILE_MS_CAP = 1000;

const BUCKET_GENRE: Readonly<Record<string, string>> = {
  chase_escape: 'arena.escape',
  collect_exit: 'arena.collect',
  survival_timer: 'arena.escape',
  checkpoint_race: 'voyage.race',
  delivery: 'quest.spatial',
  switch_puzzle: 'quest.spatial',
  hazard_crossing: 'platformer.default',
  combat_lite: 'arena.fight',
};

interface Evidence {
  readonly hero: string | null;
  readonly cellId: string | null;
  readonly essential: readonly IntentTriple[];
  readonly missing: readonly IntentTriple[];
  readonly admitted: readonly IntentTriple[];
  readonly objectiveKind: string;
  readonly requestedSeconds: number | null;
  readonly actualSeconds: number | null;
  readonly preservationFailure: boolean;
}

interface Row {
  readonly id: string;
  readonly bucket: string;
  readonly archetype: string | null;
  readonly expectArchetype: string | null;
  readonly genre: string | null;
  readonly genreHit: boolean | null;
  readonly specValid: boolean;
  readonly compiled: boolean;
  readonly reason: string | null;
  readonly publishEligible: boolean;
  readonly keypointsPassed: number;
  readonly keypointsTotal: number;
  readonly winsAtTick: number | null;
  readonly entities: number | null;
  readonly rules: number | null;
  readonly draftMs: number;
  readonly compileMs: number;
  readonly verifyMs: number;
  readonly evidence?: Evidence;
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

function verdict(row: Row): Omit<Row, 'draftMs' | 'compileMs' | 'verifyMs' | 'evidence'> {
  const { draftMs: _draft, compileMs: _compile, verifyMs: _verify, evidence: _evidence, ...rest } = row;
  return rest;
}

async function measure(entry: ReturnType<typeof goldenPrompts>[number]): Promise<Row> {
  const started = performance.now();
  const meta = draftGameSpecWithMeta(entry.prompt);
  const draftMs = round(performance.now() - started);
  const read = readGameSpec(meta.spec);
  const base = {
    id: entry.id,
    bucket: entry.bucket,
    expectArchetype: entry.expectArchetype,
    draftMs,
  };
  const none = {
    compiled: false,
    publishEligible: false,
    keypointsPassed: 0,
    winsAtTick: null,
    entities: null,
    rules: null,
    verifyMs: 0,
  };
  if (!read.ok)
    return {
      ...base,
      ...none,
      archetype: null,
      genre: null,
      genreHit: null,
      specValid: false,
      reason: read.reason,
      keypointsTotal: 0,
      compileMs: 0,
    };
  const spec = read.value;
  const archetype = spec.archetype;
  const genre = spec.genre === undefined ? null : `${spec.genre.id}.${spec.genre.mode}`;
  const promised = entry.expectArchetype === null ? undefined : BUCKET_GENRE[entry.expectArchetype];
  const genreHit = promised === undefined ? null : genre === promised;
  const compileStarted = performance.now();
  const compiled = compileGame(spec, SEED);
  const compileMs = round(performance.now() - compileStarted);
  if (!compiled.ok)
    return {
      ...base,
      ...none,
      archetype,
      genre,
      genreHit,
      specValid: true,
      reason: `${compiled.reason}: ${compiled.issues.join('; ')}`,
      keypointsTotal: spec.verification.length,
      compileMs,
    };
  const verifyStarted = performance.now();
  const quality = reportFor(compiled.value);
  const verifyMs = round(performance.now() - verifyStarted);
  const witnesses = await actionEvidence(spec, SEED);
  const essential = meta.intent === undefined ? [] : essentialTriples(meta.intent);
  const missing = meta.intent === undefined ? [] : missingActions(meta.intent, witnesses);
  const honesty = await honestyForSpec(entry.prompt, spec, SEED);
  const duration = meta.intent?.items.some(item => item.essential && item.verb === 'survive')
    ? meta.intent.counts.find(count => /^(?:seconds?|minutes?)$/.test(count.noun)) : undefined;
  const requestedSeconds = duration === undefined ? null : duration.count * (/^minute/.test(duration.noun) ? 60 : 1);
  const actualSeconds = spec.objective.kind === 'survive' ? spec.objective.seconds ?? null : null;
  const evidence: Evidence = {
    hero: meta.intent?.hero ?? null,
    cellId: meta.composition?.cellId ?? null,
    essential,
    missing,
    admitted: honesty?.unmet ?? [],
    objectiveKind: spec.objective.kind,
    requestedSeconds,
    actualSeconds,
    preservationFailure: missing.length > 0 || requestedSeconds !== null && actualSeconds !== requestedSeconds,
  };
  return {
    ...base,
    archetype,
    genre,
    genreHit,
    specValid: true,
    compiled: true,
    reason: null,
    publishEligible: quality.publishEligible,
    keypointsPassed: quality.keypoints.filter(point => point.passed).length,
    keypointsTotal: quality.keypoints.length,
    winsAtTick: quality.witness.winsAtTick,
    entities: quality.budgets.entities,
    rules: quality.budgets.rules,
    compileMs,
    verifyMs,
    evidence,
  };
}

describe('regression harness - forty historical sentences, current composition', () => {
  it('compiles and publishes 40 games with witnessed or explicitly admitted essential actions', async () => {
    const previous = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
      rows: Row[];
    };
    await loadRapier();
    const rows: Row[] = [];
    for (const entry of goldenPrompts()) {
      rows.push(await measure(entry));
    }
    const times = rows.filter(row => row.compiled).map(row => row.compileMs);
    const summary = {
      specValid: rows.filter(row => row.specValid).length,
      compiled: rows.filter(row => row.compiled).length,
      eligible: rows.filter(row => row.publishEligible).length,
      total: rows.length,
      genreHits: rows.filter(row => row.genreHit === true).length,
      withExpect: rows.filter(row => row.expectArchetype !== null).length,
      medianCompileMs: round(quantile(times, 0.5)),
      p90CompileMs: round(quantile(times, 0.9)),
    };
    const differences = rows.flatMap(row => {
      const old = previous.rows.find(old => old.id === row.id)!;
      const before = verdict(old) as Record<string, unknown>;
      const fields = Object.entries(verdict(row)).filter(([field, value]) => before[field] !== value).map(([field, value]) => ({ field, before: before[field], after: value }));
      return fields.length === 0 ? [] : [{ id: row.id, fields }];
    });
    const preservationFailures = rows.filter(row => row.evidence?.preservationFailure).map(row => row.id);
    const report = {
      schema: 'play-regression-report.v1',
      measuredAt: new Date().toISOString(),
      seed: SEED,
      rows,
      summary,
      historicalGenreHitTarget: PIN.genreHits,
      historicalDifferences: differences,
      preservationFailures,
      scope: 'Extracted essential triples plus survival duration; not full manual sentence preservation.',
    };
    writeFileSync(ARTIFACT.replace('report.json', 'p41-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const table = ['# P41 - historical 40 current-draft report', '',
      `Valid ${summary.specValid}/40; compiled ${summary.compiled}/40; eligible ${summary.eligible}/40.`,
      `Genre hits ${summary.genreHits}/${summary.withExpect}; historical target ${PIN.genreHits} (diagnostic only).`,
      `Preservation failures ${preservationFailures.length}/40; explicit admission is not preservation.`, report.scope, '',
      '| id | cell | eligible | missing triples | requested/actual seconds | preservation failure |',
      '|---|---|---|---|---|---|',
      ...rows.map(row => `| ${row.id} | ${row.evidence?.cellId ?? '-'} | ${row.publishEligible} | ${JSON.stringify(row.evidence?.missing ?? [])} | ${row.evidence?.requestedSeconds ?? '-'}/${row.evidence?.actualSeconds ?? '-'} | ${row.evidence?.preservationFailure ?? true} |`), ''];
    writeFileSync(TABLE.replace('report.md', 'p41-report.md'), table.join('\n'), 'utf8');
    expect(rows).toHaveLength(40);
    expect(summary.specValid).toBe(PIN.specValid);
    expect(summary.compiled).toBe(PIN.compiled);
    expect(summary.eligible).toBe(PIN.eligible);
    expect(summary.p90CompileMs).toBeLessThanOrEqual(P90_COMPILE_MS_CAP);
    for (const row of rows) {
      expect(row.evidence, row.id).toBeDefined();
      expect(row.keypointsPassed, row.id).toBe(row.keypointsTotal);
      // Production admission is computed independently on this final spec+seed.
      expect(row.evidence?.admitted, row.id).toEqual(row.evidence?.missing);
    }
    const sixty = rows.find(row => row.id === 'survival_timer-1')!;
    expect(sixty.evidence).toMatchObject({ objectiveKind: 'survive', requestedSeconds: 60, actualSeconds: 60 });
    expect(sixty.winsAtTick).toBe(3600);
    const ninety = rows.find(row => row.id === 'survival_timer-2')!;
    expect(ninety.evidence).toMatchObject({ hero: null, objectiveKind: 'survive', requestedSeconds: 90 });
    expect(ninety.evidence?.essential).toContainEqual({ actor: 'hero', verb: 'survive', object: null });
    expect(ninety.evidence?.essential.some(triple => triple.verb === 'glide')).toBe(false);
    expect(ninety.winsAtTick).toBe(ninety.evidence!.actualSeconds! * 60);
    if (ninety.evidence?.actualSeconds !== 90) {
      expect(preservationFailures).toContain(ninety.id);
    }
    const scale = rows.find(row => row.id === 'scale-1')!;
    expect(scale.evidence?.hero).not.toBe('two-minute');
    expect(scale.evidence?.essential.some(triple => triple.actor === 'two-minute')).toBe(false);
  }, 180000);
});

describe('regression harness – rules fixtures', () => {
  const RULES_FIXTURES = ['carry-key', 'throw-rock', 'push-crate', 'give-flower', 'lever-bridge', 'collect-gate'] as const;
  const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../src/play/arcade/__fixtures__/rules/${name}.json`, import.meta.url), 'utf8'));

  function verdictOf(raw: unknown): string {
    const read = readGameSpec(raw);
    if (!read.ok) return `spec: ${read.reason}`;
    const compiled = compileGame(read.value, SEED);
    if (!compiled.ok) return `${compiled.reason}: ${compiled.issues.join('; ')}`;
    const quality = reportFor(compiled.value);
    if (!quality.publishEligible) return 'not publishable';
    const verbs = quality.verbs ?? [];
    const silent = verbs.filter((proof) => !proof.fired).map((proof) => proof.verb);
    if (verbs.length === 0) return 'no verbs';
    return silent.length > 0 ? `unfired: ${silent.join(', ')}` : 'ok';
  }

  it.each(RULES_FIXTURES)('%s compiles, publishes and fires every verb', (name) => {
    expect(verdictOf(fixture(name))).toBe('ok');
  });

  it('throw-rock with a physics rock does the same once Rapier is loaded', async () => {
    const raw = { ...(fixture('throw-rock') as Record<string, unknown>), things: [{ role: 'rock', physics: true }] };
    await loadRapier();
    expect(verdictOf(raw)).toBe('ok');
  });
});
