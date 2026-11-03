/**
 * P68I R7: živá kontrola nabídky hry čtečce a režisérovi – dev věty hry cestou AI verze.
 *
 * Věta po větě (jedna naráz): POST věty → rychlá hra, pak dotazy na upgrade cestu až do konce (strop 600 s).
 * Zapíše žánr rychlé hry, hry ze čtení (vznikne jen, když čtení řekne jiný žánr) a AI verze režiséra, důvod konce
 * a časy od odeslání. Útrata = tokeny z logu preloadu (`p58e/usage-preload.mjs`) × ceny serveru, jako ji účtuje strop.
 *
 * Spuštění: `node evals/play/p68/director-live.mjs --game drawsave --ids d36,d38 --usage-log <file>
 * [--base http://127.0.0.1:3187]` proti `node --env-file=<P58B>/.env.local evals/play/p61/shots.mjs serve --port 3187
 * --usage-log <file> --cap-usd 1 --director-cap-usd 2` (stejné prostředí). Bez měřicí knihy
 * (`scripts/measure/eval-ledger.mjs`) nebo s nemístním `--base` skončí kódem 2 – platí server, ne tenhle klient.
 * Zapíše `evals/play/p68/director-<game>.json`.
 * T15 (G7): `--set evals/play/p68/holdout.json` vezme věty z jiné sady (výchozí `dev.json`), `--out <file>` jiný výstup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evalLedger } from '../../../scripts/measure/eval-ledger.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const GAME = arg('game');
const IDS = (arg('ids') ?? '').split(',').filter(Boolean);
const BASE = arg('base', 'http://127.0.0.1:3187');
const USAGE_LOG = arg('usage-log');
if (!GAME || IDS.length === 0 || !USAGE_LOG) throw new Error('usage: --game <id> --ids d01,d02 --usage-log <file> [--base <local url>]');
const ledger = evalLedger(process.env);
if (ledger.mode !== 'paid') {
  console.error(`fast-only: ${ledger.reason}`);
  process.exit(2);
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.error(`--base must be a local shots.mjs serve, not ${new URL(BASE).host}`);
  process.exit(2);
}

/** Ceny serveru (`shots.mjs serve`): astra jako čtečka i režisér. */
const PRICE = { in: 10, out: 50 };
const WAIT_CAP_MS = 600_000;
const POLL_MS = 1_000;
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const SET = arg('set');
const dev = JSON.parse(readFileSync(SET ?? here('./dev.json'), 'utf8')).sentences;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path, init) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 300);
      }
      return { ok: response.ok, status: response.status, body };
    } catch (thrown) {
      if (attempt >= 5 || init?.method === 'POST') throw thrown;
      await wait(2_000);
    }
  }
}

/** Žánr hry; sestavená jízda nebo mřížka `spec.genre` nenese – pak ovládání, ať se nespočítá jako „žádná hra“. */
const genreOf = async (id) => {
  const game = (await json(`/api/play/games/${id}`)).body;
  if (game?.spec?.genre) return `${game.spec.genre.id}.${game.spec.genre.mode}`;
  if (game?.chain !== undefined) return 'chain';
  const control = game?.arcade?.control?.id ?? game?.arcade?.control;
  return typeof control === 'string' ? `control:${control}` : null;
};

async function measure(row) {
  const sentAt = Date.now();
  const ms = () => Date.now() - sentAt;
  const posted = await json('/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: row.text }) });
  if (!posted.ok || typeof posted.body?.versionId !== 'string') return { id: row.id, sentence: row.text, status: 'error', reason: `POST ${posted.status}: ${JSON.stringify(posted.body).slice(0, 200)}` };
  const head = { id: row.id, sentence: row.text, quickId: posted.body.versionId, quickMs: ms(), quick: await genreOf(posted.body.versionId) };
  if (typeof posted.body.upgrade !== 'string') return { ...head, status: 'no-upgrade' };
  let status = { status: 'pending' };
  let readingId = null;
  let readingMs = null;
  while (ms() < WAIT_CAP_MS) {
    const polled = await json(posted.body.upgrade);
    if (!polled.ok) {
      status = { status: 'error', reason: `upgrade ${polled.status}` };
      break;
    }
    status = polled.body;
    if (readingId === null && typeof status?.reading?.versionId === 'string') {
      readingId = status.reading.versionId;
      readingMs = ms();
    }
    if (status.status !== 'pending') break;
    await wait(POLL_MS);
  }
  const aiId = status.status === 'ready' && typeof status.versionId === 'string' ? status.versionId : null;
  return {
    ...head,
    readingId,
    reading: readingId === null ? null : await genreOf(readingId),
    readingMs,
    status: status.status,
    reason: status.reason ?? null,
    aiMs: status.status === 'pending' ? null : ms(),
    aiId,
    ai: aiId === null ? null : await genreOf(aiId),
  };
}

function spend() {
  const calls = existsSync(USAGE_LOG) ? readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  let usd = 0;
  let withoutUsage = 0;
  for (const call of calls) {
    const tokensIn = call.usage?.prompt_tokens ?? call.usage?.input_tokens;
    const tokensOut = call.usage?.completion_tokens ?? call.usage?.output_tokens;
    if (tokensIn === undefined || tokensOut === undefined) withoutUsage += 1;
    else usd += (tokensIn * PRICE.in + tokensOut * PRICE.out) / 1_000_000;
  }
  return { calls: calls.length, withoutUsage, usd: Math.round(usd * 10_000) / 10_000 };
}

const rows = [];
for (const id of IDS) {
  const row = dev.find((sentence) => sentence.id === id);
  if (row === undefined) throw new Error(`no sentence ${id} in ${SET ?? 'dev.json'}`);
  const done = await measure(row);
  rows.push(done);
  console.log(JSON.stringify({ id: done.id, quick: done.quick, reading: done.reading, ai: done.ai, status: done.status, reason: done.reason, aiMs: done.aiMs }));
}

const target = `${GAME}.default`;
const report = {
  schema: 'p68-director-live.v1',
  game: GAME,
  about: `P68 live check: ${String(IDS.length)} P68 dev sentences of the game through the AI version on the eval ledger (evals/play/p61/shots.mjs serve, VERCEL_ENV=production, astra as reader and director). quick = the quick game, reading = the game after reading (only when the reading picks another genre), ai = the director's AI version.`,
  measured: true,
  measuredAt: new Date().toISOString(),
  ledger: { prefix: ledger.prefix, capUsd: ledger.capUsd },
  set: SET ?? 'evals/play/p68/dev.json',
  sentences: IDS,
  rows,
  summary: {
    quickInGame: rows.filter((row) => row.quick === target).length,
    readingInGame: rows.filter((row) => row.reading === target).length,
    aiReady: rows.filter((row) => row.status === 'ready').length,
    aiInGame: rows.filter((row) => row.ai === target).length,
    // Poslední hra, kterou hráč dostane: AI verze, když vznikla, jinak hra ze čtení, jinak rychlá.
    finalInGame: rows.filter((row) => (row.status === 'ready' ? row.ai : (row.reading ?? row.quick)) === target).length,
  },
  spend: spend(),
};
writeFileSync(arg('out') ?? here(`./director-${GAME}.json`),`${JSON.stringify(report, null, 1)}\n`);
console.log(`DONE ${JSON.stringify(report.summary)} spend ${JSON.stringify(report.spend)}`);
