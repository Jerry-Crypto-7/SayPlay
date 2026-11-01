/**
 * P58E live check: a chain sentence gets its paid reading on a production build (`next start`), 0.50 USD in total.
 *
 * Sentence by sentence (one at a time): POST the sentence, check it plays a chain, then poll the chain's upgrade route
 * until the reading game shows up (`reading.versionId`) and the route says final (`draft-final CHAIN`). Time is from
 * sending the sentence. Then a phone (Pixel 7) opens the chain of the first sentence that got a reading game: the page
 * must move to that game and show the `Quick | Matched` switch with no chain line.
 *
 * Spend: the server runs with `usage-preload.mjs`, which appends the provider's own `usage` of every api.openai.com call
 * to a JSONL file (`--usage-log`); cost = tokens × the prices the server runs with (`PRICE`), as `costUsd()` books it.
 *
 * Run: `WORLDSMITH_SPEND_STORE_PREFIX=<…-eval> PLAY_EVAL_SPEND_CAP_USD=<usd> node evals/play/p58e/live.mjs --usage-log <file>
 * [--base http://127.0.0.1:3131]` against `evals/play/p61/shots.mjs serve --port 3131` (same env) – without the eval ledger
 * (`scripts/measure/eval-ledger.mjs`) or with a non-local `--base` it exits 2. Writes `live.json` and
 * `live-chain-reading.png` next to this file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from '@playwright/test';

import { evalLedger } from '../../../scripts/measure/eval-ledger.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const BASE = arg('base', 'http://127.0.0.1:3131');
const USAGE_LOG = arg('usage-log');
if (!USAGE_LOG) throw new Error('--usage-log is required');
// P68I T7: celý běh je placené čtení, takže bez měřicí knihy (`-eval` předpona, kladný strop) se nepošle ani věta.
// Platí ale server, ne tenhle klient: cíl je jen místní `evals/play/p61/shots.mjs serve --port 3131`, který tutéž
// knihu kontroluje ve svém procesu – vzdálený `--base` (produkce, preview) by účtoval do své knihy.
const ledger = evalLedger(process.env);
if (ledger.mode !== 'paid') {
  console.error(`fast-only: ${ledger.reason}`);
  process.exit(2);
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.error(`--base must be a local shots.mjs serve, not ${new URL(BASE).host}`);
  process.exit(2);
}

/** Prices the server runs with (`PLAY_READER_USD_PER_MTOK_*`): astra, as P58B T7 and P58D. */
const PRICE = { in: 10, out: 50 };
const CAP_USD = 0.5;
const POLL_MS = 300;
const WAIT_CAP_MS = 60_000;

/**
 * Dev chain sentences (`p56a/holdout.json`), predicted offline from the stored astra readings (`p58b/compare-dev-t6b.json`):
 * s12 rhythm, s16 flap, s25 catch, s63 throw leave the chain with the reading; s01 stays a chain.
 */
const IDS = ['s12', 's16', 's25', 's63', 's01'];
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const dev = JSON.parse(readFileSync(here('../p56a/holdout.json'), 'utf8')).sentences;
const SENTENCES = IDS.map((id) => dev.find((row) => row.id === id));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, init = {}, attempt = 1) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
  } catch (thrown) {
    if (attempt >= 5) throw thrown;
    await wait(1_000);
    return request(path, init, attempt + 1);
  }
  if (response.status === 429 && attempt < 10) {
    await wait(1_000 * Number(response.headers.get('retry-after') ?? 2));
    return request(path, init, attempt + 1);
  }
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { ok: response.ok, status: response.status, body };
}

const genreOf = (game) => (game?.spec?.genre === undefined ? null : `${game.spec.genre.id}.${game.spec.genre.mode}`);

async function measure(row) {
  const sentAt = Date.now();
  const since = () => Date.now() - sentAt;
  const posted = await request('/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: row.text }) });
  const head = { id: row.id, sentence: row.text, chainMs: since(), chainId: posted.body?.versionId ?? null };
  if (!posted.ok || typeof posted.body?.versionId !== 'string') return { ...head, final: { status: 'error', reason: `POST ${posted.status}: ${JSON.stringify(posted.body).slice(0, 200)}` } };
  const chainId = posted.body.versionId;
  const game = (await request(`/api/play/games/${chainId}`)).body;
  const base = { ...head, chain: game?.chain !== undefined, upgrade: posted.body.upgrade ?? null };
  if (!base.chain || typeof base.upgrade !== 'string') return { ...base, final: { status: 'not-a-chain', reason: base.chain ? 'NO_UPGRADE_LINK' : genreOf(game) } };

  let readingId = null;
  let readingMs = null;
  let final = null;
  const seen = new Set();
  while (since() < WAIT_CAP_MS) {
    const polled = await request(base.upgrade);
    if (!polled.ok) {
      final = { status: 'error', reason: `upgrade ${polled.status}`, ms: since() };
      break;
    }
    const status = polled.body;
    seen.add(status.status + (status.reading ? '+reading' : ''));
    if (readingId === null && typeof status.reading?.versionId === 'string') {
      readingId = status.reading.versionId;
      readingMs = since();
    }
    if (status.status !== 'pending') {
      final = { status: status.status, reason: status.reason ?? null, ms: since() };
      break;
    }
    await wait(POLL_MS);
  }
  const reading = readingId === null ? null : (await request(`/api/play/games/${readingId}`)).body;
  return {
    ...base,
    readingId,
    readingMs,
    readingRelation: reading?.relation ?? null,
    readingParentIsChain: reading === null ? null : reading.version?.parentId === chainId,
    readingGenre: genreOf(reading),
    readingIsChain: reading === null ? null : reading.chain !== undefined,
    final: final ?? { status: 'pending', reason: 'no end within the wait cap' },
    routeStatusesSeen: [...seen],
  };
}

/** A phone opens the chain; the page must move to the reading game and show its switch. */
async function shoot(row) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await context.newPage();
    const openedAt = Date.now();
    await page.goto(`${BASE}/play/${row.chainId}`);
    await page.waitForURL(`**/play/${row.readingId}`, { timeout: 30_000 });
    const movedMs = Date.now() - openedAt;
    const state = page.getByTestId('upgrade-state');
    await state.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const shot = {
      movedMs,
      reading: await state.getAttribute('data-reading'),
      text: (await state.innerText()).replace(/\s+/g, ' ').trim(),
      chainLines: await page.getByText(/run of rounds|CHAIN/).count(),
      chainRound: await page.locator('main[data-chain-round]').count(),
    };
    await page.screenshot({ path: here('./live-chain-reading.png') });
    return shot;
  } finally {
    await browser.close();
  }
}

const rows = [];
for (const row of SENTENCES) {
  try {
    rows.push(await measure(row));
  } catch (thrown) {
    rows.push({ id: row.id, sentence: row.text, final: { status: 'error', reason: String(thrown).slice(0, 200) } });
  }
}
const first = rows.find((row) => row.readingId != null);
let screenshot = null;
if (first !== undefined) {
  try {
    screenshot = { id: first.id, ...(await shoot(first)) };
  } catch (thrown) {
    screenshot = { id: first.id, error: String(thrown).slice(0, 300) };
  }
}

const usage = existsSync(USAGE_LOG)
  ? readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
// `readerSystemPrompt()` opens with this line; the director's prompts do not.
const roleOf = (call) => ((call.role ?? '').startsWith('Read one game idea sentence') ? 'reader' : 'director');
const calls = usage.map((call) => {
  const tokensIn = call.usage?.prompt_tokens ?? null;
  const tokensOut = call.usage?.completion_tokens ?? null;
  const usd = tokensIn === null || tokensOut === null ? null : (tokensIn * PRICE.in + tokensOut * PRICE.out) / 1_000_000;
  return { at: call.at, model: call.model, kind: roleOf(call), status: call.status, tokensIn, tokensOut, usd };
});
const known = calls.filter((call) => call.usd !== null);
const readingMs = rows.flatMap((row) => (typeof row.readingMs === 'number' ? [row.readingMs] : [])).sort((a, b) => a - b);
const p50 = (sorted) => (sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
const usd = Number(known.reduce((sum, call) => sum + call.usd, 0).toFixed(6));

const report = {
  schema: 'p58e-live.v1',
  measuredAt: new Date().toISOString(),
  baseUrl: BASE,
  server: 'next start (production build), PLAY_READER_PATH=ai, reader gpt-6-astra via openai:https://api.openai.com; director endpoint unreachable on purpose (a chain never calls it)',
  capUsd: CAP_USD,
  summary: {
    sentences: rows.length,
    chains: rows.filter((row) => row.chain === true).length,
    readingGames: rows.filter((row) => row.readingId != null).length,
    sendToReadingMs: { n: readingMs.length, p50: p50(readingMs), max: readingMs.length === 0 ? null : readingMs[readingMs.length - 1] },
    finals: rows.map((row) => `${row.id}: ${row.final?.status}${row.final?.reason ? ` ${row.final.reason}` : ''}${row.readingGenre ? ` -> ${row.readingGenre}` : ''}`),
    screenshot,
  },
  spend: {
    source: 'provider usage of every api.openai.com call, logged inside the server process; usd = tokens × server prices',
    calls: calls.length,
    callsWithoutUsage: calls.length - known.length,
    usd,
    perReadingUsd: known.length === 0 ? null : Number((usd / known.length).toFixed(6)),
    byKind: Object.fromEntries(['reader', 'director'].map((kind) => [kind, Number(known.filter((call) => call.kind === kind).reduce((sum, call) => sum + call.usd, 0).toFixed(6))])),
    detail: calls,
  },
  rows,
};
writeFileSync(here('./live.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report.summary));
console.log(`spend ${report.spend.usd} USD over ${report.spend.calls} calls (${report.spend.callsWithoutUsage} without usage)`);
