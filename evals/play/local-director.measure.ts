/**
 * Lokální záloha režiséra na sadě věrnosti (P29B T9): kompaktní režisér
 * (`direct(…, { compact: true })`) nad 30 větami `evals/play/fidelity/corpus.json`
 * a zamčenou `judge-10.json`, model z `ops/llm/start.ps1 -Role fallback`.
 *
 * Pro každou větu: latence, jestli model dal platnou hru (`source: authored`),
 * proč ne (`fallbackReason`), a `read` / `drawn` z `fidelityChain` nad výslednou
 * hrou i nad draftem ze slov. Výsledek se slučuje po modelech do
 * `evals/play/local-director.json`. Robot (`check`) se tu nepouští – měří se
 * model, ne publikace. Pod zámkem GPU a jedním serverem:
 *   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/local-director.cmd
 * (`local-director.cmd` čte model z `%P29B_FALLBACK%`.)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { direct } from '@/play/director';
import { draftGameSpec } from '@/play/draft';
import { fidelityChain, type ChecklistEntry } from '@/play/fidelity/chain';
import type { GameSpecV1 } from '@/play/spec';
import { upstreamBranch, type UpstreamConfig } from '@/server/upstream';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evals', 'play', 'local-director.json');

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
}

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : (process.argv[at + 1] ?? null);
}

const load = (file: string): Sentence[] => JSON.parse(readFileSync(join(ROOT, 'evals', 'play', 'fidelity', file), 'utf8')).sentences;
const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const share = (hit: number, of: number) => (of === 0 ? 0 : Math.round((hit / of) * 1000) / 1000);

function scores(spec: GameSpecV1, checklist: readonly ChecklistEntry[]) {
  const items = fidelityChain(spec, checklist);
  return { items: items.length, read: items.filter((item) => item.read).length, drawn: items.filter((item) => item.drawn).length };
}

async function measure(sentences: readonly Sentence[], config: UpstreamConfig) {
  const branch = upstreamBranch(config);
  const rows = [];
  for (const sentence of sentences) {
    const started = performance.now();
    const directed = await direct(sentence.text, { branch, now: Date.now, compact: true });
    const ms = Math.round(performance.now() - started);
    const row = {
      id: sentence.id,
      ms,
      source: directed.source,
      fallbackReason: directed.fallbackReason,
      repairRounds: directed.repairRounds,
      calls: directed.calls,
      final: scores(directed.spec, sentence.checklist),
      draft: scores(draftGameSpec(sentence.text), sentence.checklist),
    };
    rows.push(row);
    console.log(`${sentence.id} ${String(ms)} ms ${row.source}${row.fallbackReason === null ? '' : ` ${String(row.fallbackReason)}`}`);
  }
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const items = sum((row) => row.final.items);
  const authored = rows.filter((row) => row.source === 'authored').length;
  const reasons: Record<string, number> = {};
  for (const row of rows) if (row.fallbackReason !== null) reasons[row.fallbackReason] = (reasons[row.fallbackReason] ?? 0) + 1;
  return {
    summary: {
      sentences: rows.length,
      valid: { hit: authored, of: rows.length, share: share(authored, rows.length) },
      latencyMs: { p50: quantile(rows.map((row) => row.ms), 0.5), p90: quantile(rows.map((row) => row.ms), 0.9), max: Math.max(...rows.map((row) => row.ms)) },
      read: share(sum((row) => row.final.read), items),
      drawn: share(sum((row) => row.final.drawn), items),
      draftRead: share(sum((row) => row.draft.read), items),
      draftDrawn: share(sum((row) => row.draft.drawn), items),
      fallbackReasons: reasons,
    },
    rows,
  };
}

async function main(): Promise<void> {
  const endpoint = arg('endpoint') ?? 'http://127.0.0.1:8792';
  const model = arg('model');
  if (model === null) throw new Error('usage: local-director.measure.ts --model gpt-oss-20b [--endpoint http://127.0.0.1:8792]');
  const config: UpstreamConfig = {
    endpoint: `llamacpp:${endpoint}`,
    apiKey: '',
    model,
    effort: 'low',
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    maxOutputTokens: 4000,
    // Strop jednoho volání jako `WORLDSMITH_FALLBACK_TIMEOUT_MS` v produkci (výchozí 120 s).
    timeoutMs: 120_000,
    profile: 'subscription',
    callCap: null,
  };
  const corpus = await measure(load('corpus.json'), config);
  const judge10 = await measure(load('judge-10.json'), config);
  const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as { models?: Record<string, unknown> }) : {};
  const report = {
    about: 'P29B T9: local fallback director (compact) on the fidelity corpus (30) and judge-10, llama.cpp on RTX 3090. See evals/play/read/README.md.',
    models: {
      ...previous.models,
      [model]: {
        measuredAt: new Date().toISOString(),
        commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        endpoint,
        corpus,
        judge10,
      },
    },
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify({ model, corpus: corpus.summary, judge10: judge10.summary }, null, 1));
}

await main();
