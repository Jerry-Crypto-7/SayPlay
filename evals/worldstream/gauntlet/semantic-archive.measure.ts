/**
 * **Sémantické skóre archivu plánovače proti lidským orákulům (P22 T2).**
 *
 * Osmnáct emisí ze 17. 9. 2026 (`plans/P20/t18-hybrid-v2-20260917-1803/raw`,
 * gitignorováno) dostane orákula `p20-*` z `oracles.json` – citáty, počty,
 * vztahy, zakázané objekty – a `scoreSemantics()` z `src/scene/requirements.ts`
 * je ohodnotí. Nula volání modelu; artefakt `semantic-archive.json` se commituje,
 * protože archiv sám v repu není.
 *
 * Číslo říká, co plánovač psal **před** P22, takže je to výchozí čára pro
 * živý běh gauntletu (T17), ne cíl.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/gauntlet/semantic-archive.measure.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSceneSpec } from '@/scene/spec';
import { scoreSemantics, type SemanticOracle, type SemanticScore } from '@/scene/requirements';

const ARCHIVE = fileURLToPath(new URL('../../../plans/P20/t18-hybrid-v2-20260917-1803/raw', import.meta.url));
const ARCHIVE_SOURCE = 'plans/P20/t18-hybrid-v2-20260917-1803/raw/*-planner.json (2026-09-17 archive)';
const ORACLES_FILE = fileURLToPath(new URL('./oracles.json', import.meta.url));
const REPORT_FILE = fileURLToPath(new URL('./semantic-archive.json', import.meta.url));

interface ArchiveOracle extends SemanticOracle { readonly id: string; readonly sentence: string }

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
const round = (value: number): number => Math.round(value * 1000) / 1000;

describe('the semantic score of the archived planner answers', () => {
  it('scores every archived emission against its human oracle and writes the report', () => {
    expect(existsSync(ARCHIVE), `${ARCHIVE} is missing — it is gitignored`).toBe(true);
    const oracles = (JSON.parse(readFileSync(ORACLES_FILE, 'utf8')) as { oracles: ArchiveOracle[] }).oracles
      .filter((o) => o.id.startsWith('p20-'));
    expect(oracles.length).toBe(18);

    const cases = oracles.map((oracle) => {
      const file = `${ARCHIVE}/${oracle.id.slice('p20-'.length)}-planner.json`;
      const answer = JSON.parse(readFileSync(file, 'utf8')) as { value?: { sceneSpec?: unknown } };
      const spec = readSceneSpec(answer.value?.sceneSpec);
      const score: SemanticScore | null = typeof spec === 'string' ? null : scoreSemantics(spec, oracle);
      return {
        id: oracle.id,
        sentence: oracle.sentence,
        readable: typeof spec !== 'string',
        ...(typeof spec === 'string' ? { fault: spec } : {}),
        score: score ? round(score.score) : null,
        components: score ? { presence: round(score.presence), counts: round(score.counts), relations: round(score.relations), forbidden: round(score.forbidden) } : null,
        failures: score?.failures ?? [],
      };
    });

    const scored = cases.filter((c) => c.score !== null);
    const failuresByKind = { presence: 0, counts: 0, relations: 0, forbidden: 0 };
    for (const c of cases) for (const failure of c.failures) {
      if (failure.startsWith('Missing requirement')) failuresByKind.presence += 1;
      else if (failure.startsWith('Expected')) failuresByKind.counts += 1;
      else if (failure.startsWith('Missing relation')) failuresByKind.relations += 1;
      else failuresByKind.forbidden += 1;
    }
    const component = (pick: (c: (typeof scored)[number]) => number) => round(median(scored.map(pick)));

    const report = {
      source: ARCHIVE_SOURCE,
      oracles: 'evals/worldstream/gauntlet/oracles.json (p20-*, human-written 2026-09-19)',
      scorer: 'src/scene/requirements.ts scoreSemantics() – four equally weighted components',
      cases: cases.length,
      readable: scored.length,
      medianScore: round(median(scored.map((c) => c.score!))),
      medianComponents: {
        presence: component((c) => c.components!.presence),
        counts: component((c) => c.components!.counts),
        relations: component((c) => c.components!.relations),
        forbidden: component((c) => c.components!.forbidden),
      },
      failuresByKind,
      perCase: cases,
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`semantic-archive: ${scored.length}/${cases.length} readable, median score ${report.medianScore}, failures ${JSON.stringify(failuresByKind)}`);
    expect(cases).toHaveLength(18);
  });
});
