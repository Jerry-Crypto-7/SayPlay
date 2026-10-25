/**
 * P58D live check: the reading game on a production build (`next start`), real paid calls, 0.50 USD in total.
 *
 * Sentence by sentence (one at a time): POST the sentence, take the quick game, then poll the upgrade route until it
 * reports the reading game (`pending.reading.versionId`) and until the first upgrade attempt is final. The route alone
 * does not always say "final": a transient end (`MODEL_UNAVAILABLE`, e.g. the director's spend cap refused the call) is
 * forgotten by the process, so the next poll starts a new attempt and answers `pending` again. The first attempt's end
 * is therefore also read from the server log (`[play] upgrade of <id> ended …`, `upgrade attempt settled <id>`).
 *
 * Spend: the server process runs with a preload that appends the provider's own `usage` of every api.openai.com call to
 * a JSONL file (`--usage-log`); cost = tokens × the prices the server runs with (`PRICE`), as `costUsd()` books it.
 *
 * Run: `node evals/play/p58d/live.mjs --server-log <file> --usage-log <file> [--base http://127.0.0.1:3131]`.
 * Writes `live.json` next to this file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const BASE = arg('base', 'http://127.0.0.1:3131');
const SERVER_LOG = arg('server-log');
const USAGE_LOG = arg('usage-log');
if (!SERVER_LOG || !USAGE_LOG) throw new Error('--server-log and --usage-log are required');

/** Prices the server runs with (`PLAY_READER_USD_PER_MTOK_*`, `WORLDSMITH_USD_PER_MTOK_*`): astra, as P58B T7. */
const PRICE = { in: 10, out: 50 };
const CAPS_USD = { reader: 0.44, director: 0.06, fallback: 0 };
const POLL_MS = 300;
const WAIT_CAP_MS = 240_000;
/** After the first attempt settled: how long to keep polling for the reading game the route reports. */
const AFTER_SETTLE_MS = 8_000;

/** Predicted offline (`p56a` readings + `sure: true`, `p58d/holdout.measure.ts` pattern) to give a reading game; s002 last as a control. */
const IDS = ['s003', 'h09', 'j06', 'd16', 'h02', 's002'];
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const dev = JSON.parse(readFileSync(here('../p30/dev.json'), 'utf8')).sentences;
const SENTENCES = IDS.map((id) => dev.find((row) => row.id === id));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logText = () => (existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8') : '');

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
const createdMs = (game) => {
  const at = Date.parse(game?.version?.createdAt ?? game?.createdAt ?? '');
  return Number.isFinite(at) ? at : null;
};

async function measure(row) {
  const logStart = logText().length;
  const sentAt = Date.now();
  const since = () => Date.now() - sentAt;
  const posted = await request('/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: row.text }) });
  const quickMs = since();
  const head = { id: row.id, sentence: row.text, quickMs, quickId: posted.body?.versionId ?? null };
  if (!posted.ok || typeof posted.body?.versionId !== 'string') return { ...head, final: { status: 'error', reason: `POST ${posted.status}: ${JSON.stringify(posted.body).slice(0, 200)}` } };
  const quickId = posted.body.versionId;
  const quick = (await request(`/api/play/games/${quickId}`)).body;
  const base = { ...head, chain: quick?.chain !== undefined, quickGenre: genreOf(quick) };
  if (typeof posted.body.upgrade !== 'string') return { ...base, final: { status: 'no-upgrade', reason: base.chain ? 'CHAIN' : 'NO_UPGRADE_LINK' } };

  let readingId = null;
  let readingMs = null;
  let routeFinal = null;
  let logFinal = null;
  let settledMs = null;
  const seen = new Set();
  while (since() < WAIT_CAP_MS) {
    const polled = await request(posted.body.upgrade);
    if (!polled.ok) {
      routeFinal = { status: 'error', reason: `upgrade ${polled.status}`, ms: since() };
      break;
    }
    const status = polled.body;
    seen.add(status.status + (status.reading ? '+reading' : ''));
    if (readingId === null && typeof status.reading?.versionId === 'string') {
      readingId = status.reading.versionId;
      readingMs = since();
    }
    if (status.status !== 'pending') {
      routeFinal = { status: status.status, reason: status.reason ?? null, versionId: status.versionId ?? null, ms: since() };
      break;
    }
    const log = logText().slice(logStart);
    if (logFinal === null) {
      const ended = new RegExp(`\\[play\\] upgrade of ${quickId} ended (\\S+) at (\\S+): ([^\\r\\n]*)`).exec(log);
      if (ended !== null) logFinal = { status: 'draft-final', reason: ended[1], stage: ended[2], detail: ended[3].slice(0, 200), ms: since() };
    }
    if (settledMs === null && log.includes(`[play] upgrade attempt settled ${quickId}`)) settledMs = since();
    if (settledMs !== null && (readingId !== null || since() - settledMs > AFTER_SETTLE_MS)) break;
    await wait(POLL_MS);
  }
  const log = logText().slice(logStart);
  const attempts = log.split(`[play] upgrade attempt started ${quickId}`).length - 1;
  const reading = readingId === null ? null : (await request(`/api/play/games/${readingId}`)).body;
  const aiId = routeFinal?.status === 'ready' ? routeFinal.versionId : null;
  const ai = aiId === null ? null : (await request(`/api/play/games/${aiId}`)).body;
  const final = routeFinal ?? logFinal ?? (settledMs === null ? { status: 'pending', reason: 'no end within the wait cap' } : { status: 'settled', reason: 'settled without an ended line (ready?)', ms: settledMs });
  return {
    ...base,
    readingId,
    readingMs,
    readingPublishedMs: reading === null || createdMs(reading) === null ? null : createdMs(reading) - sentAt,
    readingRelation: reading?.relation ?? null,
    readingParent: reading?.version?.parentId ?? null,
    readingGenre: genreOf(reading),
    final,
    finalMs: final.ms ?? null,
    firstAttemptSettledMs: settledMs,
    aiId,
    aiGenre: genreOf(ai),
    aiFellBackToQuickGenre: ai === null ? null : genreOf(ai) === base.quickGenre && genreOf(reading) !== base.quickGenre,
    routeStatusesSeen: [...seen],
    upgradeAttemptsStarted: attempts,
  };
}

const rows = [];
for (const row of SENTENCES) {
  try {
    rows.push(await measure(row));
  } catch (thrown) {
    rows.push({ id: row.id, sentence: row.text, final: { status: 'error', reason: String(thrown).slice(0, 200) } });
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

const report = {
  schema: 'p58d-live.v1',
  measuredAt: new Date().toISOString(),
  baseUrl: BASE,
  server: 'next start (production build), PLAY_READER_PATH=ai, reader gpt-6-astra low via openai:https://api.openai.com, director gpt-6-astra low',
  capsUsd: { ...CAPS_USD, total: CAPS_USD.reader + CAPS_USD.director + CAPS_USD.fallback },
  summary: {
    sentences: rows.length,
    readingGames: rows.filter((row) => row.readingId != null).length,
    sendToReadingMs: { n: readingMs.length, p50: p50(readingMs), max: readingMs.length === 0 ? null : readingMs[readingMs.length - 1] },
    finals: rows.map((row) => `${row.id}: ${row.final?.status}${row.final?.reason ? ` ${row.final.reason}` : ''}`),
  },
  spend: {
    source: 'provider usage of every api.openai.com call, logged inside the server process; usd = tokens × server prices',
    calls: calls.length,
    callsWithoutUsage: calls.length - known.length,
    usd: Number(known.reduce((sum, call) => sum + call.usd, 0).toFixed(6)),
    byKind: Object.fromEntries(['reader', 'director'].map((kind) => [kind, Number(known.filter((call) => call.kind === kind).reduce((sum, call) => sum + call.usd, 0).toFixed(6))])),
    detail: calls,
  },
  rows,
};
writeFileSync(here('./live.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report.summary));
console.log(`spend ${report.spend.usd} USD over ${report.spend.calls} calls (${report.spend.callsWithoutUsage} without usage)`);
