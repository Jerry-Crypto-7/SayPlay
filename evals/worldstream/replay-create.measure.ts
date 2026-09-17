/**
 * **Přehrání běhu `T14` z archivu. Nestojí ani jedno volání.**
 *
 * Běh 6. 9. 2026 trval 70 minut a 104 placených volání a skončil červeně:
 * `geometryAuthored` 9 z 30. Většina těch selhání ale nebyla v odpovědích
 * modelu — byla v kódu, který je zpracovává (`T14r-shapebounds`,
 * `T14r-orphanslot`, `T14r-identifier`). Otázka *„srovnala by tahle oprava ty
 * věty?"* má proto odpověď na disku: v `create-raw.json` leží všech 104
 * odpovědí a compiler i meshovač jsou deterministické, takže přehrání dá při
 * nezměněném kódu **tytéž** blueprinty.
 *
 * ⚠ **Tohle není měření modelu a nikde tak nesmí vystupovat.** Model
 * v přehrání nedostane ani jednu novou šanci: věta, kterou minule napsal
 * špatně, bude špatně i teď. Čísla odsud patří k opravám, ne do reportu
 * o schopnostech modelu, a bránu `K2` zavře výhradně nový živý běh.
 *
 * ## Proč `.measure.ts`, když se tu neplatí
 *
 * Sáhne na `create-raw.json`, který je v `.gitignore` — v čistém klonu tedy
 * neexistuje. Pod příponou `.test.ts` by ho `npm test` hledal a padal na
 * stroji, kde nikdo nic neměřil. `.measure.ts` znamená „pustí se, jen když si
 * o to někdo řekne", a to je přesně ono.
 *
 *     npm run measure:worldstream-replay
 *
 * ## Co po sobě nechá
 *
 * `create-replay.json`, a ten se **commituje**. Je to jediná cesta, jak se
 * tvrzení o pohybu vět dá ověřit v repu, kde archiv chybí — bez něj zůstane
 * jen v commit zprávě. `create-report.json` se přitom nepřepisuje: měří model,
 * ne kód pod ním.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';
import { compileWithRepair } from '@/model/worldstream-repair';
import { buildIntentPreview } from '@/scene/intent-preview';
import { createMeshClient } from '@/shape/mesh-client';
import { buildProxyWorld } from '@/worldstream/proxy';

import { readCorpus, type CreateCase } from './lock.mjs';
import {
  FAILURE_STAGES,
  archiveEmitter,
  buildCreateReport,
  compareReplay,
  driveCreateCase,
  type ArchiveEntry,
  type CaseOutcome,
  type CreateReport,
  type FailureStage,
} from './measure-create';

/** Musí sedět s `live-create.measure.ts`, jinak by se přehrával jiný běh. */
const SESSION_SEED = 4021;

const ARCHIVE_FILE = fileURLToPath(new URL('./create-raw.json', import.meta.url));
const REPORT_FILE = fileURLToPath(new URL('./create-report.json', import.meta.url));

/**
 * **Vlastní soubor, a proto se commituje.** `create-report.json` měří model
 * a přehrání ho přepsat nesmí; tenhle měří kód pod ním.
 */
const REPLAY_FILE = fileURLToPath(new URL('./create-replay.json', import.meta.url));

describe('the archived run, replayed against the current code', () => {
  it(
    'says which sentences the code under the model would now build',
    async () => {
      expect(
        existsSync(ARCHIVE_FILE),
        `${ARCHIVE_FILE} is missing — it is gitignored, so run npm run measure:worldstream-create first`,
      ).toBe(true);

      const archive = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8')) as ArchiveEntry[];
      const before = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as CreateReport;

      const corpus = readCorpus();
      expect(corpus.parseProblems).toEqual([]);

      const grammar = frozenGrammar();
      if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

      const mesh = createMeshClient({ allowMainThread: true });
      const cases: CaseOutcome[] = [];
      try {
        for (const entry of corpus.create as CreateCase[]) {
          cases.push(
            await driveCreateCase(entry, {
              emit: archiveEmitter(archive, entry.id),
              mesh: mesh.mesh,
              grammar: grammar.value,
              sessionSeed: SESSION_SEED,
            }),
          );
        }
      } finally {
        mesh.dispose();
      }

      const after = buildCreateReport(cases, {
        sessionSeed: SESSION_SEED,
        measuredAt: new Date().toISOString(),
        planned: corpus.create.length,
        // **Nula je tu pravda, ne výchozí hodnota.** Přehrání odpovídá
        // z archivu, takže neutratí ani jedno volání — a právě proto se
        // jeho čísla nesmějí citovat jako výkon modelu.
        paidCalls: 0,
        pricing: 'none',
      });

      const comparison = compareReplay(before, after, new Date().toISOString());
      writeFileSync(REPLAY_FILE, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');

      const tally = (stages: Readonly<Record<FailureStage, number>>): string =>
        FAILURE_STAGES.filter((stage) => stages[stage] > 0)
          .map((stage: FailureStage) => `${stage} ${String(stages[stage])}`)
          .join(', ');

      process.stdout.write(
        [
          '',
          `authored  before ${String(comparison.before.geometryAuthored)}/${String(comparison.before.attempted)}  ->  replay ${String(comparison.after.geometryAuthored)}/${String(comparison.after.attempted)}`,
          `stages    before ${tally(comparison.before.failuresByStage)}`,
          `          replay ${tally(comparison.after.failuresByStage)}`,
          comparison.moved.length === 0
            ? 'no sentence changed verdict — the replay reproduces the archived run exactly'
            : `${String(comparison.moved.length)} sentences moved:\n  ${comparison.moved
                .map(
                  (move) =>
                    `${move.id}: ${move.from} -> ${move.to}${move.detail === null ? '' : ` (${move.detail.slice(0, 120)})`}`,
                )
                .join('\n  ')}`,
          '',
          // **Co dneska padá a proč, jmenovitě.** Je to celý smysl nástroje:
          // opravovat se má podle věty, kterou kód napsal, ne podle fáze.
          'what still fails:',
          ...after.cases
            .filter((entry) => entry.failure !== null)
            .map((entry) => `  ${entry.id} ${entry.failure!.stage}: ${entry.failure!.detail}`),
          '',
          `written to ${REPLAY_FILE}`,
          '',
        ].join('\n'),
      );

      // Jediné tvrzení téhle sady: archiv se přehrál celý. Verdikt o modelu
      // tady nepadá a padnout nesmí.
      expect(after.totals.attempted).toBe(corpus.create.length);
    },
    20 * 60_000,
  );
});

/* ------------------------------------------------------------------ *
 * Fázové časy progresivního streamu (P20 A5 / T16).
 * ------------------------------------------------------------------ */

/**
 * **Čtyři fáze, které porotce vidí za sebou, každá změřená zvlášť.**
 *
 * Fáze jsou pojmenované podle toho, co na obrazovku přinese který rámec
 * `src/worldstream/events.ts`, ne podle vrstev kódu:
 *
 * | fáze | rámec | co v ní běží |
 * |---|---|---|
 * | `intent` | `intent.ready` | přečtení a validace emise planneru |
 * | `layout` | `visual.preview` | `buildIntentPreview` — neinteraktivní rozvržení ze záměru |
 * | `materials` | `blueprint.ready` | compiler včetně opravných kol: geometrie, tvary, umístění, materiály |
 * | `detail` | `world.ready` / `shape.ready` | meshing tvarů do proxy světa |
 *
 * ⚠ **Čas modelu a HTTP tady NENÍ změřený a nesmí se z tohohle souboru
 * citovat.** Přehrání odpovídá z `create-raw.json`, takže `upstream` je čas
 * čtení archivu — řádově mikrosekundy — a ne latence poskytovatele. Je
 * vedený samostatně právě proto, aby se do fázových čísel nepřimíchal.
 * Živá latence modelu se měří jinde (`live-create.measure.ts`).
 */
const PHASE_FILE = fileURLToPath(new URL('../../plans/P20/t16-phase-times.json', import.meta.url));

const PHASES = ['intent', 'layout', 'materials', 'detail'] as const;
type Phase = (typeof PHASES)[number];

const PHASE_COVERS: Record<Phase, string> = {
  intent: 'readPlannerEmission over the archived planner answer (intent.ready)',
  layout: 'buildIntentPreview: the non-interactive layout from the intent (visual.preview)',
  materials: 'compileWithRepair including repair rounds: geometry, shapes, placements, materials (blueprint.ready)',
  detail: 'buildProxyWorld: shape meshing into the proxy world (world.ready / shape.ready)',
};

/** Nearest-rank percentile. Prázdný vzorek nemá percentil, a `null` to říká. */
function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return Math.round(sorted[rank - 1] * 1000) / 1000;
}


/**
 * **Layout se nad `create-raw.json` změřit nedá a nepředstírá se opak.**
 *
 * Archiv z 6. 9. 2026 vznikl dřív, než planner začal vydávat `sceneSpec`, a
 * `buildIntentPreview` bez něj skončí na `INVALID_SCENE_SPEC` u všech třiceti
 * vět. Fáze `layout` se proto měří nad **jiným** archivem — nad plannerovými
 * odpověďmi série T18 ze 17. 9. 2026, které `sceneSpec` nesou. Je to druhý
 * zdroj a v reportu je u fáze napsaný; slučovat jeho čísla s ostatními třemi
 * fázemi do jedné „celkové latence" by byl součet dvou různých běhů.
 */
const LAYOUT_ARCHIVE = fileURLToPath(new URL('../../plans/P20/t18-hybrid-v2-20260917-1803/raw', import.meta.url));
const CREATE_SOURCE = 'evals/worldstream/create-raw.json (2026-09-06 archive, no sceneSpec)';
const LAYOUT_SOURCE = 'plans/P20/t18-hybrid-v2-20260917-1803/raw/*-planner.json (2026-09-17 archive)';

describe('the progressive phases, timed over the archive', () => {
  it(
    'separates intent, layout, materials and detail from the upstream read',
    async () => {
      expect(existsSync(ARCHIVE_FILE), `${ARCHIVE_FILE} is missing — it is gitignored`).toBe(true);
      const archive = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8')) as ArchiveEntry[];
      const corpus = readCorpus();
      expect(corpus.parseProblems).toEqual([]);
      const grammar = frozenGrammar();
      if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

      const samples: Record<Phase, number[]> = { intent: [], layout: [], materials: [], detail: [] };
      const notReached: Record<Phase, string[]> = { intent: [], layout: [], materials: [], detail: [] };
      const upstream: number[] = [];
      const mesh = createMeshClient({ allowMainThread: true });
      const clock = () => performance.now();

      try {
        for (const entry of corpus.create as CreateCase[]) {
          const answer = archiveEmitter(archive, entry.id);
          let upstreamMs = 0;
          const emit = async (request: Parameters<typeof answer>[0]): Promise<unknown> => {
            const started = clock();
            try { return await answer(request); } finally { upstreamMs += clock() - started; }
          };
          // Čistý lokální čas fáze: wall-clock minus to, co v ní strávilo čtení archivu.
          const local = (started: number, upstreamBefore: number): number =>
            clock() - started - (upstreamMs - upstreamBefore);

          let started = clock(), before = upstreamMs;
          let plan;
          try {
            const read = readPlannerEmission(await emit(buildIntentRequest(entry.prompt)));
            if (!read.ok) { notReached.intent.push(`${entry.id}: ${read.reason}`); upstream.push(upstreamMs); continue; }
            plan = read.value;
          } catch (error) {
            notReached.intent.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
            upstream.push(upstreamMs); continue;
          }
          samples.intent.push(local(started, before));

          started = clock(); before = upstreamMs;
          const outcome = await compileWithRepair({ plan, grammar: grammar.value, sessionSeed: SESSION_SEED, emit });
          const materialsMs = local(started, before);
          if (outcome.kind !== 'compiled') { notReached.materials.push(`${entry.id}: ${outcome.kind}`); upstream.push(upstreamMs); continue; }
          samples.materials.push(materialsMs);

          started = clock(); before = upstreamMs;
          const world = await buildProxyWorld(outcome, { mesh: mesh.mesh });
          const detailMs = local(started, before);
          if (world.kind === 'built') samples.detail.push(detailMs);
          else notReached.detail.push(`${entry.id}: ${world.reason}`);
          upstream.push(upstreamMs);
        }
      } finally {
        mesh.dispose();
      }

      // Layout nad druhým archivem — jediným, který nese `sceneSpec`.
      expect(existsSync(LAYOUT_ARCHIVE), `${LAYOUT_ARCHIVE} is missing`).toBe(true);
      for (const file of readdirSync(LAYOUT_ARCHIVE).filter((name) => name.endsWith('-planner.json')).sort()) {
        const read = readPlannerEmission(
          (JSON.parse(readFileSync(`${LAYOUT_ARCHIVE}/${file}`, 'utf8')) as { value?: unknown }).value,
        );
        if (!read.ok) { notReached.layout.push(`${file}: ${read.reason}`); continue; }
        const started = performance.now();
        const preview = buildIntentPreview(read.value, { sessionSeed: SESSION_SEED });
        const layoutMs = performance.now() - started;
        // Nepodporovaný vztah tenhle volitelný stage bezpečně přeskočí. Čas
        // odmítnutí není čas rozvržení a do vzorku nepatří.
        if (preview.ok) samples.layout.push(layoutMs); else notReached.layout.push(`${file}: ${preview.reason}`);
      }

      const report = {
        measuredAt: new Date().toISOString(),
        kind: 'replay of archived answers — zero model calls, no HTTP',
        sessionSeed: SESSION_SEED,
        upstream: {
          meaning: 'time spent reading the archive in place of the provider. NOT model or HTTP latency — the replay never calls a model, so no latency claim may be built on this number.',
          source: CREATE_SOURCE,
          p50Ms: percentile(upstream, 0.5), p95Ms: percentile(upstream, 0.95), samples: upstream.length,
        },
        phases: PHASES.map((phase) => ({
          phase,
          covers: PHASE_COVERS[phase],
          source: phase === 'layout' ? LAYOUT_SOURCE : CREATE_SOURCE,
          p50Ms: percentile(samples[phase], 0.5),
          p95Ms: percentile(samples[phase], 0.95),
          samples: samples[phase].length,
          notReached: notReached[phase],
          // Tally, aby se z osmnácti řádků dalo přečíst, na čem ta fáze stojí.
          notReachedByReason: notReached[phase].reduce<Record<string, number>>((tally, line) => {
            const reason = line.slice(line.indexOf(': ') + 2);
            return { ...tally, [reason]: (tally[reason] ?? 0) + 1 };
          }, {}),
        })),
        warnings: [
          'Local compute on one machine. These are not the prompt-to-world budget and G-L stays open.',
          'The layout phase comes from a different archive than the other three; the four numbers are not one run and must never be summed into a single latency.',
        ],
      };
      writeFileSync(PHASE_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      process.stdout.write(`\n${report.phases.map((p) => `${p.phase.padEnd(10)} p50 ${String(p.p50Ms)} ms  p95 ${String(p.p95Ms)} ms  n=${String(p.samples)}  unreached=${String(p.notReached.length)}`).join('\n')}\n\nwritten to ${PHASE_FILE}\n\n`);

      // Každá fáze musí mít aspoň jeden vzorek, jinak report tvrdí p50 o ničem.
      for (const phase of report.phases) expect(phase.samples, `${phase.phase} has no sample`).toBeGreaterThan(0);
      expect(upstream.length).toBeGreaterThan(0);
    },
    20 * 60_000,
  );
});
