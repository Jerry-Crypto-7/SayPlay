/**
 * Měření P37A T8: vyhraje AI verze nad návrhem ze slov? Lokální gpt-oss-20b
 * (llama.cpp na RTX 3090) jako kompaktní režisér – výchozí cesta produkce,
 * bez příkladů a bez cache – nad `dev-150.json`. Pro každou větu:
 *
 * - **brána** (`upgradeGain` nad `sentenceChecklist`): co by server udělal –
 *   AI verzi nabídne jen při zisku ≥ `MIN_UPGRADE_GAIN`;
 * - **pravda** (`upgradeGain` nad ručním seznamem věty z `dev-150.json`): jestli
 *   AI verze nad návrhem opravdu vyhrála a o kolik;
 * - **latence** volání režiséra – **lokální RTX, ne produkce** (produkce je
 *   gpt-oss-20b přes Groq).
 *
 * Robot (`check`) se nepouští – měří se model a brána, ne publikace; hra, kterou
 * by publikace odmítla (NOT_PLAYABLE), se tu počítá jako AI verze. Zapíše
 * `director.json` a `director.md`. Celé pod zámkem GPU (`director.cmd`):
 *   node D:/claude/_shared/gpu-lock.mjs --wait-max 1500 -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p37a/director.cmd
 * Zkušební běh bez modelu: `--endpoint http://127.0.0.1:9 --only u01,u02`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { direct } from '@/play/director';
import { draftGameSpec } from '@/play/draft';
import type { ChecklistEntry } from '@/play/fidelity/chain';
import { sentenceChecklist } from '@/play/fidelity/checklist';
import { MIN_UPGRADE_GAIN, specFidelity, type UpgradeGain, upgradeGain } from '@/play/fidelity/score';
import { gameSpecHash } from '@/play/spec';
import { upstreamBranch, type UpstreamConfig } from '@/server/upstream';

interface Sentence {
  readonly id: string;
  readonly group: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
}

interface Row {
  readonly id: string;
  readonly group: string;
  readonly ms: number;
  readonly source: string;
  readonly fallbackReason: string | null;
  /** AI verze, která by došla k bráně: model odpověděl a hra se liší od návrhu. */
  readonly ai: boolean;
  /** Věrnost návrhu na ručním seznamu – to hráč hraje, když AI verze nepřijde. */
  readonly draftScore: number;
  readonly gate: UpgradeGain | null;
  readonly truth: UpgradeGain | null;
  readonly genres: { readonly draft: string; readonly ai: string | null };
}

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const ROOT = here('../../../');

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : (process.argv[at + 1] ?? null);
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const mean = (values: readonly number[]) => (values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length));
const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const genreOf = (spec: { readonly genre?: { readonly id: string; readonly mode: string } }) => (spec.genre === undefined ? 'grid' : `${spec.genre.id}.${spec.genre.mode}`);

async function measureOne(sentence: Sentence, config: UpstreamConfig): Promise<Row> {
  const started = performance.now();
  const directed = await direct(sentence.text, { branch: upstreamBranch(config), now: Date.now, compact: true });
  const ms = Math.round(performance.now() - started);
  const draft = draftGameSpec(sentence.text);
  const ai = directed.source !== 'draft' && gameSpecHash(directed.spec) !== gameSpecHash(draft);
  if (ai) await Promise.all([preloadPhysics(draft, loadRapier), preloadPhysics(directed.spec, loadRapier)]);
  return {
    id: sentence.id,
    group: sentence.group,
    ms,
    source: directed.source,
    fallbackReason: directed.fallbackReason,
    ai,
    gate: ai ? upgradeGain(draft, directed.spec, sentenceChecklist(sentence.text).checklist) : null,
    draftScore: specFidelity(draft, sentence.checklist).score,
    truth: ai ? upgradeGain(draft, directed.spec, sentence.checklist) : null,
    genres: { draft: genreOf(draft), ai: directed.source === 'draft' ? null : genreOf(directed.spec) },
  };
}

/** Souhrn řádků. Podíly jsou ze všech vět; průměrný zisk jen z vět, kde AI verze došla k bráně. */
function summarize(rows: readonly Row[]) {
  const reached = rows.filter((row) => row.ai);
  const wins = (row: Row) => row.truth !== null && row.truth.better;
  const offered = (row: Row) => row.gate !== null && row.gate.better;
  const reasons: Record<string, number> = {};
  for (const row of rows.filter((candidate) => !candidate.ai)) {
    const reason = row.source === 'draft' ? (row.fallbackReason ?? 'MODEL_UNAVAILABLE') : 'UNCHANGED';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  // Ruční seznam: co hráč skončí hrát – bez brány AI verzi vždy, s bránou jen nabídnutou.
  const finalScore = (pick: (row: Row) => boolean) => mean(rows.map((row) => (row.truth !== null && pick(row) ? row.truth.ai : row.draftScore)));
  const share = (count: number) => (rows.length === 0 ? 0 : round(count / rows.length));
  const count = (pick: (row: Row) => boolean) => rows.filter(pick).length;
  return {
    sentences: rows.length,
    threshold: MIN_UPGRADE_GAIN,
    aiReachedGate: reached.length,
    noAiVersion: reasons,
    truth: {
      aiWins: { count: count(wins), share: share(count(wins)) },
      aiLoses: count((row) => row.truth !== null && row.truth.gain <= -MIN_UPGRADE_GAIN),
      meanGain: mean(reached.map((row) => row.truth!.gain)),
    },
    gate: {
      offered: { count: count(offered), share: share(count(offered)) },
      meanGain: mean(reached.map((row) => row.gate!.gain)),
      agreement: {
        offeredAndWins: count((row) => offered(row) && wins(row)),
        offeredButNotBetter: count((row) => offered(row) && !wins(row)),
        blockedButWins: count((row) => row.ai && !offered(row) && wins(row)),
        blockedAndNotBetter: count((row) => row.ai && !offered(row) && !wins(row)),
      },
    },
    handChecklistFinal: {
      draftOnly: finalScore(() => false),
      aiAlways: finalScore(() => true),
      withGate: finalScore(offered),
    },
    latencyMs: { label: 'local RTX 3090, llama.cpp gpt-oss-20b – not production', p50: quantile(rows.map((row) => row.ms), 0.5), p95: quantile(rows.map((row) => row.ms), 0.95), max: Math.max(...rows.map((row) => row.ms)) },
    byGroup: Object.fromEntries(
      [...new Set(rows.map((row) => row.group))].map((group) => {
        const of = rows.filter((row) => row.group === group);
        return [group, { n: of.length, aiReachedGate: of.filter((row) => row.ai).length, offered: of.filter(offered).length, aiWins: of.filter(wins).length }];
      }),
    ),
  };
}

function markdown(summary: ReturnType<typeof summarize>, header: { readonly measuredAt: string; readonly commit: string; readonly model: string }): string {
  const { truth, gate, handChecklistFinal: final, latencyMs: latency } = summary;
  const pct = (share: number) => `${String(Math.round(share * 1000) / 10)} %`;
  return [
    '# P37A T8 – vyhraje AI verze nad návrhem?',
    '',
    `Lokální ${header.model} (llama.cpp, RTX 3090) jako kompaktní režisér nad \`dev-150.json\`, commit \`${header.commit}\`, ${header.measuredAt.slice(0, 10)}. Vygenerováno skriptem \`director.measure.ts\`, data v \`director.json\`. Robot publikace se nepouštěl.`,
    '',
    '| | počet | podíl ze 150 |',
    '|---|---|---|',
    `| AI verze došla k bráně (model odpověděl, hra se liší od návrhu) | ${String(summary.aiReachedGate)} | ${pct(summary.aiReachedGate / summary.sentences)} |`,
    `| **AI verze vyhraje nad návrhem o ≥ ${String(summary.threshold)}** (ruční seznam) | **${String(truth.aiWins.count)}** | **${pct(truth.aiWins.share)}** |`,
    `| AI verze prohraje o ≥ ${String(summary.threshold)} (ruční seznam) | ${String(truth.aiLoses)} | ${pct(truth.aiLoses / summary.sentences)} |`,
    `| brána by AI verzi nabídla (seznam z věty) | ${String(gate.offered.count)} | ${pct(gate.offered.share)} |`,
    '',
    `- **Průměrný zisk AI verze** nad návrhem (věty, kde došla k bráně): ${String(truth.meanGain)} na ručním seznamu, ${String(gate.meanGain)} na seznamu z věty.`,
    `- **Shoda brány s ručním seznamem:** nabídla a vyhrála ${String(gate.agreement.offeredAndWins)}, nabídla bez výhry ${String(gate.agreement.offeredButNotBetter)}, zastavila výhru ${String(gate.agreement.blockedButWins)}, zastavila nevýhru ${String(gate.agreement.blockedAndNotBetter)}.`,
    `- **Co hráč skončí hrát** (průměrná věrnost na ručním seznamu přes všechny věty): jen návrh ${String(final.draftOnly)}, AI verze vždy ${String(final.aiAlways)}, s bránou ${String(final.withGate)}.`,
    `- Bez AI verze: ${Object.entries(summary.noAiVersion).map(([reason, count]) => `${reason} ${String(count)}`).join(', ') || '–'}.`,
    `- **Latence režiséra – lokální RTX, ne produkce:** p50 ${String(latency.p50)} ms, p95 ${String(latency.p95)} ms, max ${String(latency.max)} ms. Produkce je gpt-oss-20b přes Groq a změří ji P30A T9/T10.`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const endpoint = arg('endpoint') ?? 'http://127.0.0.1:8792';
  const model = arg('model') ?? 'gpt-oss-20b';
  const only = arg('only');
  const ids = only === null ? null : new Set(only.split(','));
  const set = (JSON.parse(readFileSync(here('./dev-150.json'), 'utf8')) as { sentences: Sentence[] }).sentences.filter((sentence) => ids === null || ids.has(sentence.id));
  // Tatáž konfigurace jako lokální záloha P29B (`evals/play/local-director.measure.ts`).
  const config: UpstreamConfig = {
    endpoint: `llamacpp:${endpoint}`,
    apiKey: '',
    model,
    effort: 'low',
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    maxOutputTokens: 4000,
    timeoutMs: 120_000,
    profile: 'subscription',
    callCap: null,
  };
  const rows: Row[] = [];
  for (const sentence of set) {
    const row = await measureOne(sentence, config);
    rows.push(row);
    console.log(`${row.id} ${String(row.ms)} ms ${row.ai ? `gate ${String(row.gate!.gain)} truth ${String(row.truth!.gain)}` : (row.fallbackReason ?? 'UNCHANGED')}`);
  }
  const header = {
    about: 'P37A T8: does the AI version beat the draft? Local gpt-oss-20b as the compact director over dev-150; gate = derived checklist, truth = hand-written checklist. Latency is local RTX 3090, not production. See director.md.',
    measuredAt: new Date().toISOString(),
    commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    model,
    endpoint,
    only,
  };
  const summary = summarize(rows);
  console.log(JSON.stringify(summary, null, 1));
  // Zkušební běh (`--only`) souhrn sady nepřepíše.
  if (only !== null) return;
  writeFileSync(here('./director.json'), `${JSON.stringify({ header, summary, rows }, null, 1)}\n`);
  writeFileSync(here('./director.md'), markdown(summary, header));
}

await main();
