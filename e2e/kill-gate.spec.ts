/**
 * Kill gate (T21) — jediný běh, který vyrobí `evals/kill-gate-report.json`.
 *
 * Protáhne **obě** živé větve za sebou proti témuž běžícímu produkčnímu serveru:
 * tvorbu (`runLiveChain`, 15 promptů) a tříúpravovou relaci (`runEditSessions`,
 * 4 relace po třech tazích). Z obou pak složí jeden artefakt, podle kterého se
 * rozhoduje HALT brána za touhle úlohou.
 *
 * ## Strop platí přes obě větve, ne dvakrát
 *
 * `runLiveChain` i `runEditSessions` si počítají volání od nuly, každý ze svého
 * `env`. Pustit je za sebou se stejným `EVAL_CALL_CAP` by znamenalo, že schválený
 * strop platí **dvakrát** — což je přesně ten druh nominálního stropu, před
 * kterým varuje hlavička `preflight.ts`. Druhá větev proto dostane strop snížený
 * o volání, která spotřebovala první.
 *
 * ## Prahy se sem nepíšou, vlastnosti ano
 *
 * Táž konvence jako `live-chain.spec.ts`: model odpovídá pokaždé jinak, takže
 * připíchnuté číslo by dělalo test, který zčervená při každém běhu. Aserce míří
 * na vlastnosti artefaktu — čitatelem je `FULFILLED`, razítko profilu sedí na to,
 * co leží na disku, clusterů je dost, neúplnost se přiznává. **Jestli práh
 * padne, rozhoduje člověk nad reportem, ne tenhle soubor.**
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnvConfig } from '@next/env';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { killGateReport, writeKillGateReport, type KillGateReport } from '../evals/harness/kill-gate';
import { KILL_GATE_REPORT, PreflightError, runLiveChain } from '../evals/harness/live';
import { runEditSessions } from '../evals/harness/session';
import type { TraceInput } from '../src/sim/interpreter';
import type { VerifiableWorld, VerifyResult } from '../src/verify/witness';

test.describe.configure({ mode: 'serial' });

/** `.env.local` čte Next v serverovém procesu; Playwright běží vedle něj. */
loadEnvConfig(process.cwd());

const requested = process.env.EVAL_LIVE === '1';

let cached: KillGateReport | null = null;
let reportPathOnDisk = '';
let pageReplays = -1;

const replayIn = (page: Page) => async (world: unknown, witness: unknown) =>
  page.evaluate(
    ([doc, trace]) => {
      const counted = window as unknown as { __replays?: number };
      counted.__replays = (counted.__replays ?? 0) + 1;
      return window.__worldsmith!.verify(doc as VerifiableWorld, trace as TraceInput[]);
    },
    [world, witness] as const,
  ) as Promise<VerifyResult>;

async function measure(page: Page, request: APIRequestContext): Promise<KillGateReport> {
  if (cached !== null) return cached;

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith?.verify !== undefined, undefined, { timeout: 60_000 });

  const replay = replayIn(page);
  const post = async (path: '/api/emit' | '/api/edit', data: unknown) => {
    const response = await request.post(path, { data });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status(), body };
  };

  try {
    const create = await runLiveChain({ env: process.env, provider: 'allowlist', replay });

    // Zbytek stropu, ne celý strop znovu. U metrovaného profilu drží dolary
    // `EVAL_SPEND_CAP_USD` a snižovat se nemusí — tam je jednotkou útrata, ne
    // počet volání, a druhá větev si ji sečte od nuly ke stejnému stropu.
    const remaining = process.env.EVAL_CALL_CAP === undefined
      ? process.env
      : { ...process.env, EVAL_CALL_CAP: String(Math.max(Number(process.env.EVAL_CALL_CAP) - create.calls, 0)) };

    const edit = await runEditSessions({
      env: remaining,
      provider: 'allowlist',
      transport: { post, replay },
    });

    cached = killGateReport({ create, edit });
  } catch (thrown) {
    if (thrown instanceof PreflightError)
      throw new Error(
        `EVAL_LIVE=1 je nastavené, ale měření nešlo spustit. ${thrown.failure.reason}: ${thrown.failure.detail}`,
      );
    throw thrown;
  }

  reportPathOnDisk = writeKillGateReport(cached);
  pageReplays = await page.evaluate(() => (window as unknown as { __replays?: number }).__replays ?? 0);
  return cached;
}

// ---------------------------------------------------------------------------

test('report vznikne a nese razítko profilu nad každým číslem', async ({ page, request }) => {
  test.skip(!requested, 'kill gate se objednává přes EVAL_LIVE=1 — bez objednávky se neutrácí');
  test.setTimeout(1_800_000);
  const report = await measure(page, request);

  expect(existsSync(reportPathOnDisk), 'report se nezapsal').toBe(true);
  expect(reportPathOnDisk).toBe(join(process.cwd(), 'evals', KILL_GATE_REPORT));

  const onDisk = JSON.parse(readFileSync(reportPathOnDisk, 'utf8')) as KillGateReport;
  expect(Object.keys(onDisk).slice(0, 2)).toEqual(['schema', 'gate']);
  expect(onDisk.gate.grade === 'GATE' || onDisk.gate.grade === 'DEVELOPMENTAL').toBe(true);

  // Razítko sedí na to, co doopravdy leží v `evals/live/<runId>/responses/`.
  for (const dir of onDisk.run.responseDirs) expect(existsSync(dir), `${dir} chybí`).toBe(true);

  for (const rate of [onDisk.fulfilledRate, onDisk.rawPatchPassRate, onDisk.firstRequestCommitRate]) {
    expect(rate.numerator, `${rate.id} nemá FULFILLED v čitateli`).toBe('FULFILLED');
    expect(rate.claimable, `${rate.id} se rozešlo s razítkem brány`).toBe(report.gate.headlineClaimable);
  }
});

test('report stojí na dost nezávislých světech a přiznává neúplnost', async ({ page, request }) => {
  test.skip(!requested, 'kill gate se objednává přes EVAL_LIVE=1');
  test.setTimeout(1_800_000);
  const report = await measure(page, request);

  // `killGateReport` by pod minimem vůbec nevznikl — tohle je jeho doložení.
  expect(report.corpus.clusters).toBeGreaterThanOrEqual(report.corpus.minWorldClusters);

  if (report.complete) {
    expect(report.completedCases).toBe(report.plannedCases);
    expect(report.incompleteReason).toBeNull();
  } else {
    expect(report.incompleteReason, 'report je neúplný a neřekl proč').not.toBeNull();
  }
});

test('replay proběhl v prohlížeči a nikde neuniknul zmrazený korpus', async ({ page, request }) => {
  test.skip(!requested, 'kill gate se objednává přes EVAL_LIVE=1');
  test.setTimeout(1_800_000);
  const report = await measure(page, request);

  expect(report.findings.harnessFailures.filter((failure) => failure.kind === 'frozen-leak')).toEqual([]);
  expect(report.findings.harnessFailures.filter((failure) => failure.kind === 'browser-divergence')).toEqual([]);
  expect(report.findings.harnessFailures.filter((failure) => failure.kind === 'provider')).toEqual([]);

  // Počítadlo žije v paměti stránky. Doprava, která prohlížeč obejde a hash si
  // spočítá v Node, ho nezvedne — a `0 === 0` je přesně ten stav, který sem
  // nesmí projít (lekce z T19).
  expect(pageReplays, 'prohlížeč neprovedl ani jeden replay').toBeGreaterThan(0);
});

test('naměřená čísla se vypíšou tak, jak se budou citovat', async ({ page, request }) => {
  test.skip(!requested, 'kill gate se objednává přes EVAL_LIVE=1');
  test.setTimeout(1_800_000);
  const report = await measure(page, request);

  const pct = (value: number | null): string => (value === null ? '   n/a' : `${(value * 100).toFixed(1)}%`);
  const rate = (block: { id: string; successes: number; trials: number; rate: number | null; floor: number | null; meetsFloor: boolean | null }): string =>
    `${block.id.padEnd(24)} ${String(block.successes).padStart(3)}/${String(block.trials).padEnd(3)} = ${pct(block.rate)}` +
    `${block.floor === null ? '' : `  práh ${pct(block.floor)} ${block.meetsFloor === true ? 'SPLNĚN' : 'NESPLNĚN'}`}`;

  console.log(
    [
      '',
      `=== kill gate (T21) grade=${report.gate.grade} profily=${report.gate.profiles.join('+')} model=${report.run.model} ===`,
      report.gate.reason,
      report.gate.headlineClaimable ? '' : '!! ŽÁDNÉ z čísel níž není výsledek brány. Cituje se i s tímhle řádkem.',
      rate(report.fulfilledRate),
      rate(report.rawPatchPassRate),
      rate(report.firstRequestCommitRate),
      `strukturální kontrakt      ${report.structuralContract.clean}/${report.structuralContract.accepted} přijatých bez vady`,
      `relace (měřeno)            ${report.threeEditSession.sessionsPassed}/${report.threeEditSession.sessionsCompleted} = ${pct(report.threeEditSession.rate)}` +
        `  tahy ${report.threeEditSession.turnsPassed}/${report.threeEditSession.turnsRun}, dopočet z nezávislosti ${pct(report.threeEditSession.independenceEstimate)}`,
      `clusterovaný interval      ${pct(report.clustered.rate)} [${pct(report.clustered.interval.lower)}, ${pct(report.clustered.interval.upper)}] nad ${report.corpus.clusters} světy`,
      `commit do prvního volání   ${report.timeToCommit.committedOnRawEmission} syrově, ${report.timeToCommit.committedAfterOneRepair} po opravě, ${report.timeToCommit.neverCommitted} nikdy`,
      ...report.perClassFloors.map(
        (aggregate) =>
          `  třída ${aggregate.classId.padEnd(17)} ${aggregate.successes}/${aggregate.trials} práh ${pct(aggregate.floor)} ${aggregate.gated ? '(hradí)' : '(jen se vykazuje)'}`,
      ),
      `complete=${report.complete} ${report.incompleteReason ?? ''}`,
      ...report.findings.frozenBodyMatches.map((match) => `NÁLEZ shoda těla: ${match.caseId} — ${match.detail}`),
      ...report.findings.harnessFailures.map((failure) => `FAIL ${failure.kind} ${failure.caseId}: ${failure.detail}`),
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  expect(report.cases.length).toBeGreaterThan(0);
});
