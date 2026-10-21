/**
 * Přečte sadu vět čtečkou přes skutečný transport (P56A T4) a zapíše čtení do
 * `evals/play/p56a/readings/<sada>.<model>.json`. Z těch souborů pak měří T5–T7
 * a T11 bez modelu; replay ani testy čtečku nevolají.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p56a/read-set.ts --set evals/play/p56a/audit-12.json --endpoint llamacpp:http://127.0.0.1:8792 --budget 60000 [--model gpt-oss-20b] [--out <soubor>]
 *
 * Transport je týž kód jako na rychlé cestě (`readBeforeDraft`): `llamacpp:`
 * lokální gpt-oss pod zámkem GPU (`evals/play/p56a/read-all.cmd`), `codex-cli`
 * předplatné (astra, ne model dema – soubor to nese v názvu), `openai:` s
 * `PLAY_READER_KEY` a cenou z prostředí přes procesní strop.
 *
 * Po průchodu se každá věta přečte podruhé: cache po větě musí odpovědět bez
 * dalšího volání transportu (`cache.extraCalls` = 0).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBeforeDraft, readerConfigFromEnv, readerPromptVersion } from '@/play/read/client';
import type { Reading } from '@/play/read/schema';
import { memoryAnswerStore } from '@/server/answer-cache';
import { processSpendCap } from '@/server/spend-cap';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const setPath = arg('set');
const endpoint = arg('endpoint');
if (setPath === undefined || endpoint === undefined) {
  console.error('usage: read-set.ts --set <file.json> --endpoint <llamacpp:url|openai:url|codex-cli> [--budget ms] [--model name] [--out file]');
  process.exit(2);
}
const budget = arg('budget') ?? '60000';
const local = endpoint.startsWith('llamacpp:');
const model = arg('model') ?? (local ? 'gpt-oss-20b' : undefined);

const env: Record<string, string | undefined> = {
  ...process.env,
  PLAY_READER: 'on',
  PLAY_READER_ENDPOINT: endpoint,
  PLAY_READER_BUDGET_MS: budget,
  ...(model === undefined ? {} : { PLAY_READER_MODEL: model }),
};
const config = readerConfigFromEnv(env);
if (config === null) {
  console.error(`the reader is not configured for ${endpoint} (openai: needs PLAY_READER_KEY, PLAY_READER_MODEL and PLAY_READER_USD_PER_MTOK_OUT)`);
  process.exit(2);
}

interface Row {
  readonly id: string;
  readonly text: string;
}
const set = JSON.parse(readFileSync(resolve(ROOT, setPath), 'utf8')) as { sentences: Row[] };
const setDir = basename(dirname(resolve(ROOT, setPath)));
const setName = setDir === 'p56a' ? basename(setPath, '.json') : `${setDir}-${basename(setPath, '.json')}`;
const out = resolve(ROOT, arg('out') ?? join('evals', 'play', 'p56a', 'readings', `${setName}.${config.model.replace(/[^\w.-]+/g, '-')}.json`));

let transportCalls = 0;
const fetchImpl: typeof fetch = (input, init) => {
  transportCalls += 1;
  return fetch(input, init);
};
const store = memoryAnswerStore();
const deps = { fetchImpl, store };

const rows: { id: string; text: string; ms: number; reading: Reading | null }[] = [];
for (const row of set.sentences) {
  const started = performance.now();
  const reading = await readBeforeDraft(row.text, env, deps);
  const ms = Math.round(performance.now() - started);
  rows.push({ id: row.id, text: row.text, ms, reading });
  console.log(`${row.id} ${String(ms).padStart(6)} ms  ${reading === null ? 'null' : `${reading.genre === null ? '-' : `${reading.genre.genre}.${reading.genre.mode}`} hero=${reading.hero ?? '-'} foe=${reading.foe ?? '-'} title=${reading.title ?? '-'}`}`);
}

// Druhé čtení: tatáž věta, verze promptu a model = uložené čtení, žádné volání.
const callsBefore = transportCalls;
let sameAgain = 0;
for (const row of rows) {
  if (row.reading === null) continue;
  const again = await readBeforeDraft(row.text, env, deps);
  if (JSON.stringify(again) === JSON.stringify(row.reading)) sameAgain += 1;
}
const counted = config.endpoint !== 'codex-cli';

const sorted = rows.map((row) => row.ms).sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
const valid = rows.filter((row) => row.reading !== null);
const summary = {
  n: rows.length,
  valid: valid.length,
  genreAndHero: valid.filter((row) => row.reading!.genre !== null && row.reading!.hero !== null).length,
  withFoe: valid.filter((row) => row.reading!.foe !== null).length,
  withTitle: valid.filter((row) => row.reading!.title !== null).length,
  p50Ms: pct(50),
  p95Ms: pct(95),
  maxMs: sorted.at(-1) ?? 0,
};
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const transport = config.endpoint === 'codex-cli' ? 'codex-cli' : config.endpoint.startsWith('openai:') ? `openai:${new URL(config.endpoint.slice(7)).host}` : config.endpoint;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      schema: 'p56a-readings.v1',
      set: relative(ROOT, resolve(ROOT, setPath)).replaceAll('\\', '/'),
      model: config.model,
      transport,
      ...(config.endpoint === 'codex-cli' ? { note: 'codex-cli = astra on the subscription, not the demo model; its numbers do not predict Groq' } : {}),
      promptVersion: readerPromptVersion(),
      budgetMs: config.timeoutMs,
      commit,
      readAt: new Date().toISOString(),
      summary,
      cache: { rereads: valid.length, sameAgain, extraCalls: counted ? transportCalls - callsBefore : null },
      ...(config.pricing.usdPerMTokOut > 0 ? { spendCap: processSpendCap().snapshot() } : {}),
      readings: rows,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `${setName}: valid ${summary.valid}/${summary.n}, genre+hero ${summary.genreAndHero}/${summary.n}, p50 ${summary.p50Ms} ms, p95 ${summary.p95Ms} ms; ` +
    `cache ${sameAgain}/${valid.length} same, extra calls ${counted ? transportCalls - callsBefore : 'n/a'} -> ${relative(ROOT, out)}`,
);
