#!/usr/bin/env node
/**
 * P61 T1: snímky her pro slepého soudce kvality (`judge.mjs`). Tři příkazy:
 *
 *   node --env-file=<worktree P58B>/.env.local evals/play/p61/shots.mjs serve --port 3161 --usage-log <file> [--cap-usd 2]
 *     Spustí `next start` (hotový `npm run build`) s placenou čtečkou astra jen pro AI verzi a režisérem, jehož model
 *     nikam nevede – zaplatí se jen čtení věty. Klíč `OPENAI_API_KEY` z `--env-file` jde do serveru jako
 *     `PLAY_READER_KEY`; do logu, výstupu ani repa nikdy. `VERCEL_ENV=production` dá strop knihu procesu (bez ní
 *     strop odmítne vše, paměť „Místní placený běh chce VERCEL_ENV“). Útratu zapisuje `p58e/usage-preload.mjs`.
 *     Proces žije jako rodič serveru: pouštět jako úlohu na pozadí, zastavit podle PID z prvního řádku.
 *     P68I T7: čtení se platí jen z měřicí knihy (`scripts/measure/eval-ledger.mjs`: `WORLDSMITH_SPEND_STORE_PREFIX`
 *     končící `-eval`, kladný `PLAY_EVAL_SPEND_CAP_USD`, strop čtečky je menší z něj a `--cap-usd`). Bez ní server
 *     hraje jen rychlou hru a první řádek nese `EVAL_LEDGER=fast-only <důvod>`. Kniha útraty jde do
 *     `WORLDSMITH_SPEND_STORE_*`, je-li zadané (pak je strop kumulativní napříč běhy); hry zůstávají v paměti.
 *
 *   node evals/play/p61/shots.mjs shoot --set <sada.json> [--range 0..11] --out <dir> --label main --base http://127.0.0.1:3161
 *     Věta po větě (jeden proces naráz – souběžné focení server zasekne): POST věty → rychlá hra, hned 3 snímky
 *     v 1, 3 a 5 s s upgrade cestou zablokovanou v prohlížeči (jinak řetěz během focení přejde na hru ze čtení)
 *     a bez mezerníku (pozastaví hru); desktop 1280 × 720, pak Pixel 7 na výšku. Mezitím dotazy na upgrade cestu
 *     do `reading.versionId` nebo konce; hra ze čtení, když vznikla, dostane totéž. `<dir>/shots.json` nese časy
 *     od odeslání věty a id verzí; hotové věty se při dalším běhu nepřefocují.
 *
 *   node evals/play/p61/shots.mjs spend --usage-log <file>
 *     Útrata čtení z logu preloadu: tokeny × ceny serveru (10 / 50 USD za Mtok), jako ji účtuje strop.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evalLedger } from '../../../scripts/measure/eval-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PRICE = { in: 10, out: 50 };
const AT_MS = [1000, 3000, 5000];
const READING_WAIT_MS = 60_000;

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function serve() {
  const port = flag('--port', '3161');
  const usageLog = flag('--usage-log');
  const key = process.env.OPENAI_API_KEY;
  const ledger = evalLedger(process.env);
  const paid = ledger.mode === 'paid';
  if (paid && (!usageLog || !key)) throw new Error('serve needs --usage-log and OPENAI_API_KEY from node --env-file=<P58B>/.env.local');
  console.log(paid ? `EVAL_LEDGER=paid ${ledger.prefix} cap ${String(ledger.capUsd)} USD` : `EVAL_LEDGER=fast-only ${ledger.reason}`);
  const env = { ...process.env };
  // Hry jen v paměti procesu: `KV_REST_API_*` je i úložiště her, měřené hry nemají co dělat ve feedu.
  const drop = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'WORLDSMITH_FALLBACK_ENDPOINT'];
  for (const name of paid ? drop : [...drop, 'WORLDSMITH_SPEND_STORE_URL', 'WORLDSMITH_SPEND_STORE_TOKEN']) delete env[name];
  const reader = paid
    ? {
        PLAY_READER: 'on',
        PLAY_READER_PATH: 'ai',
        PLAY_READER_ENDPOINT: 'openai:https://api.openai.com',
        PLAY_READER_MODEL: 'gpt-6-astra',
        PLAY_READER_KEY: key,
        PLAY_READER_EFFORT: 'low',
        PLAY_READER_USD_PER_MTOK_IN: String(PRICE.in),
        PLAY_READER_USD_PER_MTOK_OUT: String(PRICE.out),
        PLAY_READER_SPEND_CAP_USD: String(Math.min(Number(flag('--cap-usd', '2')), ledger.capUsd)),
        P58E_USAGE_LOG: path.resolve(usageLog),
      }
    : { PLAY_READER: 'off' };
  Object.assign(env, {
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    NODE_OPTIONS: `--import ${pathToFileURL(path.join(ROOT, 'evals/play/p58e/usage-preload.mjs')).href}`,
    ...reader,
    PLAY_READER_CALL_CAP: '200',
    PLAY_READER_CALLS_PER_CALLER: '1000',
    // Režisér je objednaný, ale jeho model nikam nevede: brány čtení (`mayPayRead`) ho potřebují nastaveného,
    // zaplatit se nemá nic než čtení. Volání skončí hned `MODEL_UNAVAILABLE`.
    WORLDSMITH_BRANCH: 'live',
    WORLDSMITH_MODEL_ENDPOINT: 'openai:http://127.0.0.1:9',
    WORLDSMITH_MODEL_KEY: 'unreachable',
    WORLDSMITH_MODEL: 'none',
    WORLDSMITH_MODEL_PROFILE: 'api',
    WORLDSMITH_USD_PER_MTOK_OUT: '1',
    WORLDSMITH_SPEND_CAP_USD: '100',
    PLAY_DIRECTOR_CALLS_PER_CALLER: '1000',
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/next/dist/bin/next'), 'start', '-p', port, '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`SERVER_PID=${child.pid} PORT=${port}`);
  child.on('exit', (code) => {
    console.log(`EXIT=${code}`);
    process.exit(code ?? 1);
  });
}

function spend() {
  const usageLog = flag('--usage-log');
  const lines = existsSync(usageLog) ? readFileSync(usageLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const calls = lines.map((call) => {
    const tokensIn = call.usage?.prompt_tokens ?? call.usage?.input_tokens ?? null;
    const tokensOut = call.usage?.completion_tokens ?? call.usage?.output_tokens ?? null;
    return { model: call.model, status: call.status, usd: tokensIn === null || tokensOut === null ? null : (tokensIn * PRICE.in + tokensOut * PRICE.out) / 1_000_000 };
  });
  const usd = calls.reduce((sum, call) => sum + (call.usd ?? 0), 0);
  console.log(JSON.stringify({ calls: calls.length, withoutUsage: calls.filter((call) => call.usd === null).length, usd: Math.round(usd * 10000) / 10000 }));
}

async function request(base, url, init = {}, attempt = 1) {
  let response;
  try {
    response = await fetch(`${base}${url}`, { cache: 'no-store', ...init });
  } catch (thrown) {
    if (attempt >= 5) throw thrown;
    await wait(1000);
    return request(base, url, init, attempt + 1);
  }
  if (response.status === 429 && attempt < 10) {
    await wait(1000 * Number(response.headers.get('retry-after') ?? 2));
    return request(base, url, init, attempt + 1);
  }
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { ok: response.ok, status: response.status, body };
}

async function shoot() {
  const { chromium, devices } = await import('@playwright/test');
  const base = flag('--base', 'http://127.0.0.1:3161');
  const out = path.resolve(flag('--out'));
  const setFile = path.resolve(flag('--set'));
  const all = JSON.parse(readFileSync(setFile, 'utf8')).sentences;
  const [from, to] = (flag('--range') ?? `0..${all.length - 1}`).split('..').map(Number);
  const sentences = all.slice(from, to + 1);
  mkdirSync(out, { recursive: true });
  const file = path.join(out, 'shots.json');
  const record = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { schema: 'p61-shots.v1', label: flag('--label', 'main'), commit: flag('--commit', null), set: path.relative(ROOT, setFile).replaceAll('\\', '/'), range: [from, to], base, at: AT_MS, views: { desktop: '1280x720', phone: 'Pixel 7 portrait' }, rows: [] };
  const save = () => writeFileSync(file, `${JSON.stringify({ ...record, measuredAt: new Date().toISOString() }, null, 1)}\n`);

  const browser = await chromium.launch();
  const views = {
    desktop: { viewport: { width: 1280, height: 720 } },
    phone: { ...devices['Pixel 7'] },
  };

  async function shots(versionId, dir, view) {
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext(views[view]);
    const page = await context.newPage();
    // Stránka se nesmí dozvědět o hře ze čtení (ani o AI verzi), jinak během focení přejde jinam.
    await page.route('**/upgrade**', (route) => route.abort());
    await page.goto(`${base}/play/${versionId}`);
    await page.waitForSelector('canvas', { timeout: 60_000 });
    const box = await page.locator('canvas').first().boundingBox();
    const start = Date.now();
    const files = [];
    for (const [i, at] of AT_MS.entries()) {
      // Hráč: klepnutí do středu a pár šipek, ať se hra hýbe jako při hraní; mezerník ne – ten hru pozastaví.
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (view === 'phone') await page.touchscreen.tap(x, y);
      else {
        await page.mouse.click(x, y);
        for (const key of ['ArrowRight', 'ArrowUp']) await page.keyboard.press(key);
      }
      const left = at - (Date.now() - start);
      if (left > 0) await wait(left);
      const shot = path.join(dir, `shot-${i + 1}.png`);
      await page.screenshot({ path: shot });
      files.push(shot);
    }
    const finalUrl = page.url();
    await context.close();
    return { files, stayed: finalUrl.endsWith(versionId) };
  }

  const genreOf = async (id) => {
    const game = (await request(base, `/api/play/games/${id}`)).body;
    return { genre: game?.spec?.genre ? `${game.spec.genre.id}.${game.spec.genre.mode}` : null, chain: game?.chain !== undefined, look: game?.spec?.theme?.look ?? null };
  };

  for (const row of sentences) {
    if (record.rows.some((done) => done.id === row.id)) continue;
    const sentAt = Date.now();
    const posted = await request(base, '/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: row.text }) });
    const quickMs = Date.now() - sentAt;
    if (!posted.ok || typeof posted.body?.versionId !== 'string') {
      record.rows.push({ id: row.id, sentence: row.text, error: `POST ${posted.status}: ${JSON.stringify(posted.body).slice(0, 200)}` });
      save();
      console.log(JSON.stringify({ id: row.id, error: posted.status }));
      continue;
    }
    const quickId = posted.body.versionId;
    let readingId = null;
    let readingMs = null;
    let lastStatus = null;
    const poll = (async () => {
      while (Date.now() - sentAt < READING_WAIT_MS && typeof posted.body.upgrade === 'string') {
        const status = (await request(base, posted.body.upgrade)).body;
        lastStatus = `${status?.status}${status?.reason ? ` ${status.reason}` : ''}`;
        if (readingId === null && typeof status?.reading?.versionId === 'string') {
          readingId = status.reading.versionId;
          readingMs = Date.now() - sentAt;
        }
        if (status?.status !== 'pending') return;
        await wait(300);
      }
    })();
    const dir = path.join(out, row.id);
    const quick = { desktop: await shots(quickId, path.join(dir, 'desktop', 'quick'), 'desktop'), phone: await shots(quickId, path.join(dir, 'phone', 'quick'), 'phone') };
    await poll;
    const reading = readingId === null ? null : { desktop: await shots(readingId, path.join(dir, 'desktop', 'reading'), 'desktop'), phone: await shots(readingId, path.join(dir, 'phone', 'reading'), 'phone') };
    const entry = {
      id: row.id,
      sentence: row.text,
      quickId,
      quickMs,
      quick: await genreOf(quickId),
      readingId,
      readingMs,
      reading: readingId === null ? null : await genreOf(readingId),
      lastStatus,
      stayed: { quick: quick.desktop.stayed && quick.phone.stayed, reading: reading === null ? null : reading.desktop.stayed && reading.phone.stayed },
      shots: Object.fromEntries(['desktop', 'phone'].map((view) => [view, { quick: quick[view].files, reading: reading?.[view].files ?? [] }])),
    };
    record.rows.push(entry);
    save();
    // Jen id a časy: věty a žánry zapečetěné sady na výstup nejdou.
    console.log(JSON.stringify({ id: row.id, quickMs, readingMs, stayed: entry.stayed }));
    await wait(3000);
  }
  await browser.close();
  save();
  console.log(`DONE ${record.rows.length} rows -> ${file}`);
}

const command = args[0];
if (command === 'serve') serve();
else if (command === 'spend') spend();
else if (command === 'shoot') await shoot();
else throw new Error('usage: shots.mjs serve|shoot|spend …');
