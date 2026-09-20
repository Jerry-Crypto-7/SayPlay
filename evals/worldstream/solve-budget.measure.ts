/**
 * **Stojí širší hledání svědka za to? Odpověď leží na disku, ne v úvaze.**
 *
 * `SOLVE_BUDGET` (`src/model/repair.ts`) říká, kolik replayů a odsimulovaných
 * tiků dostane hledač vítězné cesty, než to vzdá. Rozšířit ho vypadá jako
 * zlepšení samo od sebe — jenže širší hledání umí taky jen prodloužit marné
 * hledání ve světech, které stejně nikdy nevyhrají, a tím posunout latenci
 * odmítnutí přímo před porotcem. Rozhodnout to smí jen měření.
 *
 * Měřit se dá zadarmo: v `create-raw.json` leží 104 archivovaných odpovědí
 * modelu z běhu 6. 9. 2026 (seed 4021), z toho 72 nese celý světový graf.
 * Compiler, opravy i hledač jsou deterministické, takže se nad nimi dá týž
 * hledač pustit dvakrát — jednou se starým rozpočtem, jednou s kandidátem —
 * a rozdíl je pak naměřený, ne odhadnutý.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/solve-budget.measure.ts
 *
 * ## Proč `.measure.ts`, když se tu neplatí
 *
 * Táž věc jako u `replay-create.measure.ts`: sáhne na `create-raw.json`, který
 * je v `.gitignore`. Pod příponou `.test.ts` by ho `npm test` hledal a padal na
 * stroji, kde nikdo nic neměřil.
 *
 * ## Kandidát: 4× uzly a tiky, hloubka a rozestup beze změny
 *
 * Rozšiřují se **jen zdrojové meze** (`maxNodes` 20 000 → 80 000, `maxTicks`
 * 40 000 → 160 000). Hloubka a rozestup se nehýbou schválně:
 *
 * - `maxDepth` je stejně shora omezená politikou tieru (`policy.maxInputs`),
 *   takže její zvednutí většinou nezmění nic — a kde ano, rozšíří šířkové
 *   prohledávání exponenciálně, což už není „táž otázka s víc místem".
 * - `settleTicks` by posunulo tik každého vstupu, takže by se nalezená stopa
 *   mohla lišit i tam, kde stará prošla. To není rozpočet, to je jiný hledač.
 *
 * ⚠ **Milisekundy se tu měří, ale nerozhodují.** Rozpočet zůstává v uzlech
 * a tikách, protože prohlížeč a Node musí dát tutéž odpověď (`src/verify/solve.ts`).
 * Naměřený čas jde do artefaktu jako cena, kterou to stojí, a nikdy do mezí.
 *
 * ## Co po sobě nechá
 *
 * `solve-budget.json`, a ten se **commituje** — je to jediná cesta, jak se
 * rozhodnutí o rozpočtu dá přečíst v repu, kde archiv chybí. Pole `verdict`
 * říká, co z měření vyšlo: `widened` (kandidát certifikoval případ, který
 * starý rozpočet nezvládl, a `SOLVE_BUDGET` se zvedl) nebo `no new cases`
 * (kandidát nepřidal nic, takže **zůstává starý rozpočet**).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { repairEmission } from '@/model/repair';
import { TIER_POLICY, isTier } from '@/verify/tiers';
import { solveWitnessDetailed, type SolveOptions } from '@/verify/solve';
import { verifyWitness } from '@/verify/witness';

import { readCorpus, type CreateCase } from './lock.mjs';
import { type ArchiveEntry } from './measure-create';

/** Musí sedět s `live-create.measure.ts`, jinak by se přehrával jiný běh. */
const SESSION_SEED = 4021;

const ARCHIVE_FILE = fileURLToPath(new URL('./create-raw.json', import.meta.url));
const OUT_FILE = fileURLToPath(new URL('./solve-budget.json', import.meta.url));
const SOURCE = 'evals/worldstream/create-raw.json (2026-09-06 archive, seed 4021, 104 calls / 30 cases)';

/** Rozpočet, pod kterým padly dosavadní verdikty (P19 R6, 16. 9. 2026). */
const OLD_BUDGET: SolveOptions = { maxNodes: 20_000, maxTicks: 40_000, maxDepth: 6, settleTicks: 30 };

/** Kandidát: čtyřnásobek obou zdrojových mezí, nic jiného. */
const CANDIDATE_BUDGET: SolveOptions = { maxNodes: 80_000, maxTicks: 160_000, maxDepth: 6, settleTicks: 30 };

interface Run {
  readonly status: string;
  readonly certified: boolean;
  readonly nodes: number;
  readonly ticks: number;
  readonly ms: number;
  readonly moves: number | null;
}

interface CaseRecord {
  readonly id: string;
  readonly caseId: string;
  readonly call: number;
  readonly prompt: string | null;
  readonly old: Run;
  readonly candidate: Run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Obálka svědka přesně tak, jak ji staví `witnessEnvelope()` v `repair.ts`
 * **před** hledáním. Opravený dokument už nese nalezenou stopu, a ta by druhé
 * hledání obešla — tohle vrací sim do stavu, ve kterém do hledače vstupuje.
 */
function preSearchWitness(sim: Record<string, unknown>): Record<string, unknown> {
  const witness = isRecord(sim.witness) ? sim.witness : {};
  const tier = typeof witness.tier === 'string' && isTier(witness.tier) ? witness.tier : 'short';
  return { ...witness, tier, H_cert: TIER_POLICY[tier].maxHorizonTicks, ops: [] };
}

/** Nearest-rank percentil. Prázdný vzorek percentil nemá, a `null` to říká. */
function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return Math.round(sorted[rank - 1] * 1000) / 1000;
}

function searchOnce(world: Parameters<typeof solveWitnessDetailed>[0], budget: SolveOptions): Run {
  const started = performance.now();
  const diagnostic = solveWitnessDetailed(world, budget);
  const ms = Math.round((performance.now() - started) * 1000) / 1000;
  const found = diagnostic.result;
  // Certifikuje se TÝMŽ verifikátorem jako v produkci — hledač si vlastní
  // certifikát nevydává, a měření si ho nesmí vydat taky.
  const certified =
    found !== null && verifyWitness({ ...world, trace: found.ops }, found.ops).verdict === 'CERTIFIED';
  return {
    status: diagnostic.status,
    certified,
    nodes: diagnostic.nodes,
    ticks: diagnostic.ticks,
    ms,
    moves: found === null ? null : found.ops.length,
  };
}

describe('the witness search budget, measured over the archive', () => {
  it(
    'says whether a wider search certifies a world the current budget misses',
    () => {
      expect(
        existsSync(ARCHIVE_FILE),
        `${ARCHIVE_FILE} is missing — it is gitignored, so run npm run measure:worldstream-create first`,
      ).toBe(true);

      const archive = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8')) as ArchiveEntry[];
      const corpus = readCorpus();
      expect(corpus.parseProblems).toEqual([]);
      const prompts = new Map((corpus.create as CreateCase[]).map((entry) => [entry.id, entry.prompt]));

      const cases: CaseRecord[] = [];
      /** Emise, které do hledače v produkci vůbec nedojdou, a proč. */
      const skipped: string[] = [];

      for (const entry of archive) {
        const answer = isRecord(entry.answer) ? entry.answer : null;
        const emitted = answer !== null && isRecord(answer.world) ? answer.world : null;
        if (emitted === null || !isRecord(emitted.sim)) continue;
        const id = `${entry.caseId}#${String(entry.call)}`;

        // Tytéž opravy, jaké běží v produkci před hledáním. Vlastní hledání
        // uvnitř `repairEmission` se zahazuje: měří se až dvě volání níž, obě
        // nad týmž postaveným světem a se stejně měřenými hodinami.
        const repaired = repairEmission(emitted);
        const repairedSim = isRecord(repaired.document) && isRecord(repaired.document.sim)
          ? repaired.document.sim
          : null;
        if (repairedSim === null) {
          skipped.push(`${id}: the repair returned no sim`);
          continue;
        }

        const built = buildRuntimeWorld({ ...repairedSim, witness: preSearchWitness(emitted.sim) });
        if (!built.ok) {
          // Svět, který se nepostaví, hledač nikdy neuvidí — odmítne ho
          // certifikace s vlastním důvodem. Do rozpočtu nemá co mluvit.
          skipped.push(`${id}: the world graph did not build (${String(built.issues.length)} issues)`);
          continue;
        }

        cases.push({
          id,
          caseId: entry.caseId,
          call: entry.call,
          prompt: prompts.get(entry.caseId) ?? null,
          old: searchOnce(built.world, OLD_BUDGET),
          candidate: searchOnce(built.world, CANDIDATE_BUDGET),
        });
      }

      const certifiedOld = cases.filter((entry) => entry.old.certified);
      const certifiedNew = cases.filter((entry) => entry.candidate.certified);
      const gained = cases.filter((entry) => entry.candidate.certified && !entry.old.certified);
      const lost = cases.filter((entry) => entry.old.certified && !entry.candidate.certified);
      const movedTrace = cases.filter(
        (entry) => entry.old.certified && entry.candidate.certified && entry.old.moves !== entry.candidate.moves,
      );

      const oldMs = cases.map((entry) => entry.old.ms);
      const newMs = cases.map((entry) => entry.candidate.ms);
      const verdict = gained.length > 0 ? 'widened' : 'no new cases';

      const tally = (pick: (entry: CaseRecord) => Run): Record<string, number> =>
        cases.reduce<Record<string, number>>((into, entry) => {
          const status = pick(entry).status;
          return { ...into, [status]: (into[status] ?? 0) + 1 };
        }, {});

      // **Tohle je číslo, které verdikt rozhoduje.** Případ se statusem
      // `budget-exhausted` je jediný, kterému by širší rozpočet mohl pomoct;
      // `search-exhausted` znamená, že hledači došel prostor, ne rozpočet, a
      // tomu nepřidá ani stonásobek.
      const hitTheBudget = cases.filter((entry) => entry.old.status === 'budget-exhausted');
      const share = (used: number, cap: number): number => Math.round((used / cap) * 1000) / 10;

      const report = {
        measuredAt: new Date().toISOString(),
        kind: 'replay of archived world graphs — zero model calls, no HTTP',
        source: SOURCE,
        sessionSeed: SESSION_SEED,
        /**
         * Co z měření vyplynulo pro `SOLVE_BUDGET` v `src/model/repair.ts`.
         * `no new cases` znamená, že tam zůstává `budgets.old`.
         */
        verdict,
        verdictDetail:
          gained.length > 0
            ? `The candidate certified ${String(gained.length)} world(s) the current budget missed, so SOLVE_BUDGET moves to budgets.candidate.`
            : `No world in the archive ever reached the current budget: ${String(hitTheBudget.length)} of ${String(cases.length)} ended as budget-exhausted, the rest either solved or ran the search space dry. Widening a limit nothing touches cannot certify anything new, so SOLVE_BUDGET stays at budgets.old.`,
        budgets: { old: OLD_BUDGET, candidate: CANDIDATE_BUDGET },
        limitsAreTimeFree:
          'Both budgets are expressed in replay nodes and simulated ticks. The milliseconds below are the price of the search, never an input to it — a wall-clock cut-off would make the browser and Node disagree.',
        summary: {
          worldsSearched: cases.length,
          skipped: skipped.length,
          certifiedOld: certifiedOld.length,
          certifiedCandidate: certifiedNew.length,
          newlyCertified: gained.map((entry) => entry.id),
          lostCertification: lost.map((entry) => entry.id),
          tracesThatMoved: movedTrace.map((entry) => entry.id),
          statuses: { old: tally((entry) => entry.old), candidate: tally((entry) => entry.candidate) },
          /** Kolik z rozpočtu nejhladovější svět doopravdy snědl. */
          budgetPressure: {
            casesThatHitTheOldBudget: hitTheBudget.map((entry) => entry.id),
            nodesUsedPercentOfOldCap: share(Math.max(0, ...cases.map((entry) => entry.old.nodes)), OLD_BUDGET.maxNodes),
            ticksUsedPercentOfOldCap: share(Math.max(0, ...cases.map((entry) => entry.old.ticks)), OLD_BUDGET.maxTicks),
          },
          old: {
            p50SearchMs: percentile(oldMs, 0.5),
            p95SearchMs: percentile(oldMs, 0.95),
            maxSearchMs: percentile(oldMs, 1),
            maxNodesUsed: Math.max(0, ...cases.map((entry) => entry.old.nodes)),
            maxTicksUsed: Math.max(0, ...cases.map((entry) => entry.old.ticks)),
          },
          candidate: {
            p50SearchMs: percentile(newMs, 0.5),
            p95SearchMs: percentile(newMs, 0.95),
            maxSearchMs: percentile(newMs, 1),
            maxNodesUsed: Math.max(0, ...cases.map((entry) => entry.candidate.nodes)),
            maxTicksUsed: Math.max(0, ...cases.map((entry) => entry.candidate.ticks)),
          },
        },
        warnings: [
          'Replay of one archived run on one machine. It measures the searcher, not the model, and closes no gate.',
          'Milliseconds vary with the machine; the nodes and ticks do not. Read the counts first.',
        ],
        skipped,
        cases,
      };

      writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

      process.stdout.write(
        [
          '',
          `worlds searched   ${String(cases.length)} (skipped ${String(skipped.length)})`,
          `certified         old ${String(certifiedOld.length)}  ->  candidate ${String(certifiedNew.length)}`,
          `newly certified   ${gained.length === 0 ? 'none' : gained.map((entry) => entry.id).join(', ')}`,
          `lost              ${lost.length === 0 ? 'none' : lost.map((entry) => entry.id).join(', ')}`,
          `traces that moved ${movedTrace.length === 0 ? 'none' : movedTrace.map((entry) => entry.id).join(', ')}`,
          `search ms         old p50 ${String(percentile(oldMs, 0.5))} p95 ${String(percentile(oldMs, 0.95))}  ->  candidate p50 ${String(percentile(newMs, 0.5))} p95 ${String(percentile(newMs, 0.95))}`,
          `statuses          old ${JSON.stringify(tally((entry) => entry.old))}  ->  candidate ${JSON.stringify(tally((entry) => entry.candidate))}`,
          `budget pressure   ${String(hitTheBudget.length)} worlds hit the old budget; peak use ${String(share(Math.max(0, ...cases.map((entry) => entry.old.nodes)), OLD_BUDGET.maxNodes))}% of maxNodes, ${String(share(Math.max(0, ...cases.map((entry) => entry.old.ticks)), OLD_BUDGET.maxTicks))}% of maxTicks`,
          `verdict           ${verdict}`,
          '',
          `written to ${OUT_FILE}`,
          '',
        ].join('\n'),
      );

      // Jediné tvrzení téhle sady: bylo co měřit. Verdikt o rozpočtu padá
      // v artefaktu, ne v aserci.
      expect(cases.length).toBeGreaterThan(0);
      // Širší rozpočet nesmí ubrat: kdyby ubral, není to rozšíření a nesmí se
      // nasadit bez vysvětlení.
      expect(lost.map((entry) => entry.id)).toEqual([]);
    },
    60 * 60_000,
  );
});
