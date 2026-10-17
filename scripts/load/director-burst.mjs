#!/usr/bin/env node
/**
 * Zátěžová zkouška fronty režiséra (P53 T4): N hráčů pošle větu během 2 s na
 * jednu instanci a všichni mají dostat AI verzi – pozdější počkají ve frontě.
 *
 *   node scripts/load/director-burst.mjs --players 8 --slots 2
 *
 * Spustí náhradní OpenAI-kompatibilní upstream na `127.0.0.1` (nahrané odpovědi
 * režiséra z `src/play/director/__fixtures__/p46-answers` podle věty, zpoždění
 * `--delay-ms`, počítá souběžná volání), nad ním `next start` z hotového buildu
 * (`npm run build` předem) a pošle věty. **Nikam jinam se nevolá**: prostředí
 * serveru se staví bez proměnných modelu, sdíleného úložiště a Vercelu a se
 * souborem `.env*` v kořeni se nespustí, takže placený endpoint ani sdílený
 * klíč nedostane nic.
 *
 * Dva běhy do `--out` (výchozí `evals/play/director-queue/report.json`):
 * `burst` s výchozí frontou (úspěch = N/N `ready`, 0× `MODEL_UNAVAILABLE`,
 * souběh na upstreamu = `--slots` – menší by znamenal frontu, která pouští
 * po jednom) a `overflow` s `PLAY_DIRECTOR_QUEUE=2`
 * (přebytek dostane `MODEL_UNAVAILABLE` a sonda `time-to-playable` ověří, že
 * jeho rychlá verze se hraje). `--only burst|overflow` pustí jen jeden.
 * Úspěch se počítá z AI verze (`ready` s jiným id než návrh), nikdy z rychlé.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(ROOT, 'src/play/director/__fixtures__/p46-answers');
/** Rozpočet režie (270 s) + rezerva klienta (15 s) + chvíle na publikaci. */
const SETTLE_MS = 300_000;
/** Dotaz na stav každé hry jednou za 4 s: 8 her = 20 dotazů za 10 s, pod stropem 50 na volajícího. */
const POLL_MS = 4_000;

/** Nahrané odpovědi, které v P46E daly AI verzi (`failure: null`). */
export function loadAnswers() {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')))
    .filter((row) => row.failure === null && row.answer !== null && typeof row.sentence === 'string');
}

/**
 * Náhradní upstream: odpověď podle věty, kterou tělo požadavku obsahuje (opravné
 * kolo a pokyn nese tutéž větu), po `delayMs`. `peak` = nejvíc volání naráz.
 */
export function stubUpstream(answers, delayMs) {
  const bySentence = [...answers].sort((a, b) => b.sentence.length - a.sentence.length);
  const stats = { calls: 0, unknown: 0, inFlight: 0, peak: 0, firstCallAt: {} };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      // Jen zprávy uživatele: systémový pokyn nese příkladové věty a jedna z nich
      // je i ve fixturách – kratší věta by pak dostala cizí odpověď (naměřeno: h02).
      let said = body;
      try {
        said = JSON.parse(body).messages.filter((message) => message.role === 'user').map((message) => String(message.content)).join('\n');
      } catch {
        // nečitelné tělo: hledá se v celém
      }
      const lower = said.toLowerCase();
      const row = bySentence.find((candidate) => lower.includes(candidate.sentence.toLowerCase()));
      stats.calls += 1;
      if (row === undefined) {
        stats.unknown += 1;
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'stub: unknown sentence' } }));
        return;
      }
      stats.firstCallAt[row.sentence] ??= Date.now();
      stats.inFlight += 1;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      setTimeout(() => {
        stats.inFlight -= 1;
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(row.answer) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2000, completion_tokens: 900 },
          }),
        );
      }, delayMs);
    });
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      ready({ root: `http://127.0.0.1:${String(port)}`, stats, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** Prostředí bez modelu, sdíleného úložiště, Vercelu a dřívějších pák PLAY – jen to, co zkouška nastaví. */
function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(WORLDSMITH_|PLAY_|KV_|UPSTASH_|VERCEL|GROQ|OPENAI|ANTHROPIC|TOGETHER|FIREWORKS)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Soubory `.env*`, ze kterých by `next start` doplnil klíče, jež `cleanEnv`
 * vynechal (`@next/env` doplní jen klíč chybějící v prostředí) – i placenou
 * zálohu a sdílené úložiště. `.env.example` Next nečte. Bez ohledu na velikost
 * písmen: Windows otevře `.ENV.local`, když Next chce `.env.local`.
 */
export function envFilesIn(root) {
  return readdirSync(root).filter((name) => /^\.env(\..+)?$/i.test(name) && name.toLowerCase() !== '.env.example');
}

/** `next start` nad náhradním upstreamem; vrací adresu a zastavení. */
export async function startServer({ port, upstream, slots, queue, root = ROOT }) {
  const envFiles = envFilesIn(root);
  if (envFiles.length > 0)
    throw new Error(`refusing to start: ${envFiles.join(', ')} in ${root} would hand next start a real model endpoint, key or shared store; move it away for the burst test`);
  // Obsazený port by odpověděl cizí server dřív, než náš `next start` spadne na EADDRINUSE.
  await new Promise((free, taken) => {
    const probe = createServer().once('error', () => taken(new Error(`port ${String(port)} is already in use: the burst would measure that server, not its own`)));
    probe.listen(port, '127.0.0.1', () => probe.close(free));
  });
  const store = mkdtempSync(join(tmpdir(), 'p53-burst-store-'));
  const env = cleanEnv({
    NODE_ENV: 'production',
    // Kniha útraty mimo Vercel jen pro `production`/`preview`, jinak strop každé
    // volání odmítne (`ledgerFromEnv`); bez `VERCEL` je to kniha v paměti procesu.
    VERCEL_ENV: 'preview',
    PLAY_STORE_DIR: store,
    WORLDSMITH_BRANCH: 'live',
    WORLDSMITH_MODEL_ENDPOINT: `openai:${upstream}`,
    WORLDSMITH_MODEL: 'openai/gpt-oss-20b',
    WORLDSMITH_MODEL_PROFILE: 'metered',
    WORLDSMITH_MODEL_KEY: 'stub-key',
    WORLDSMITH_USD_PER_MTOK_IN: '0.05',
    WORLDSMITH_USD_PER_MTOK_OUT: '0.2',
    WORLDSMITH_SPEND_CAP_USD: '5',
    // Všichni hráči jsou tu jeden volající (`untrusted`): bez tohohle by denní
    // strop 12 volání měřil kvótu, ne frontu. V produktu zůstává výchozí.
    PLAY_DIRECTOR_CALLS_PER_CALLER: '1000',
    PLAY_DIRECTOR_SLOTS: String(slots),
    ...(queue === undefined ? {} : { PLAY_DIRECTOR_QUEUE: String(queue) }),
  });
  const child = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const keep = (chunk) => {
    log.push(String(chunk));
    if (log.length > 400) log.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const base = `http://127.0.0.1:${String(port)}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited ${String(child.exitCode)}:\n${log.join('').slice(-2000)}`);
    try {
      if ((await fetch(`${base}/play`)).ok) break;
    } catch {
      // ještě neposlouchá
    }
    if (Date.now() - started > 120_000) throw new Error('next start did not answer within 120 s');
    await new Promise((next) => setTimeout(next, 1_000));
  }
  return {
    base,
    log,
    stop: async () => {
      child.kill();
      await new Promise((done) => (child.exitCode === null ? child.once('exit', done) : done()));
      rmSync(store, { recursive: true, force: true });
    },
  };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

/** Jeden běh: věty během `spreadMs`, pak dotazy na stav, dokud všechny AI verze nedoběhnou. */
export async function burst({ players, slots, queue, delayMs = 3_000, port = 3312, spreadMs = 2_000, probe = false, root = ROOT }) {
  const answers = loadAnswers();
  if (answers.length < players) throw new Error(`only ${String(answers.length)} recorded answers for ${String(players)} players`);
  const rows = answers.slice(0, players);
  const upstream = await stubUpstream(answers, delayMs);
  // Bez zavření by otevřený port náhradního upstreamu držel Node naživu a příkaz by po odmítnutí visel.
  const server = await startServer({ port, upstream: upstream.root, slots, queue, root }).catch(async (thrown) => {
    await upstream.close();
    throw thrown;
  });
  try {
    const games = await Promise.all(
      rows.map(async (row, index) => {
        await new Promise((next) => setTimeout(next, Math.round((index * spreadMs) / players)));
        const postedAt = Date.now();
        const response = await fetch(`${server.base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: row.sentence }) });
        const body = await response.json().catch(() => ({}));
        return { id: row.id, sentence: row.sentence, postedAt, postStatus: response.status, draftId: typeof body.versionId === 'string' ? body.versionId : null, status: 'pending', versionId: null, reason: null, queuedMax: 0 };
      }),
    );
    const deadline = Date.now() + SETTLE_MS;
    while (games.some((game) => game.draftId !== null && game.status === 'pending') && Date.now() < deadline) {
      await new Promise((next) => setTimeout(next, POLL_MS));
      for (const game of games.filter((candidate) => candidate.draftId !== null && candidate.status === 'pending')) {
        const response = await fetch(`${server.base}/api/play/games/${game.draftId}/upgrade`, { cache: 'no-store' });
        if (!response.ok) continue;
        const body = await response.json();
        if (typeof body.queued === 'number') game.queuedMax = Math.max(game.queuedMax, body.queued);
        if (body.status === 'ready') Object.assign(game, { status: 'ready', versionId: body.versionId });
        if (body.status === 'draft-final') Object.assign(game, { status: 'draft-final', reason: body.reason });
      }
    }
    const results = games.map(({ postedAt, ...game }) => {
      const first = upstream.stats.firstCallAt[game.sentence];
      // AI verze = `ready` s vlastním id, ne návrh: rychlá verze se tu nikdy nepočítá jako úspěch.
      const aiVersion = game.status === 'ready' && game.versionId !== null && game.versionId !== game.draftId;
      return { ...game, aiVersion, waitMs: first === undefined ? null : first - postedAt };
    });
    const waits = results.map((game) => game.waitMs).filter((wait) => wait !== null);
    const refused = results.filter((game) => game.reason === 'MODEL_UNAVAILABLE');
    let playable = null;
    if (probe && refused.length > 0) {
      const { measure } = await import('../measure/time-to-playable.mjs');
      const probed = await measure({ url: `${server.base}/play/${refused[0].draftId}`, headless: true, timeoutMs: 60_000 });
      playable = { draftId: refused[0].draftId, playable: probed.playable, ms: probed.ms, note: probed.note ?? null };
    }
    return {
      players,
      slots,
      queue: queue ?? 'default',
      delayMs,
      spreadMs,
      aiVersions: results.filter((game) => game.aiVersion).length,
      modelUnavailable: refused.length,
      pending: results.filter((game) => game.status === 'pending').length,
      upstreamPeak: upstream.stats.peak,
      upstreamCalls: upstream.stats.calls,
      upstreamUnknown: upstream.stats.unknown,
      queuedSeen: results.filter((game) => game.queuedMax > 0).length,
      waitMedianMs: median(waits),
      waitMaxMs: waits.length === 0 ? null : Math.max(...waits),
      ...(playable === null ? {} : { refusedQuickVersion: playable }),
      games: results,
    };
  } finally {
    await server.stop();
    await upstream.close();
  }
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

/** Bez `await` na nejvyšší úrovni: e2e (Playwright) načítá modul přes `require()`, a ten ho u ESM s TLA odmítne. */
async function main() {
  const players = Number(arg('players', '8'));
  const slots = Number(arg('slots', '2'));
  const delayMs = Number(arg('delay-ms', '3000'));
  const port = Number(arg('port', '3312'));
  const only = arg('only', null);
  const out = resolve(ROOT, arg('out', 'evals/play/director-queue/report.json'));
  const runs = {};
  if (only !== 'overflow') runs.burst = await burst({ players, slots, delayMs, port });
  if (only !== 'burst') runs.overflow = await burst({ players, slots, queue: 2, delayMs, port, probe: true });
  const report = { schema: 'p53-director-burst.v1', generatedAt: new Date().toISOString(), upstream: 'stub on 127.0.0.1, recorded answers src/play/director/__fixtures__/p46-answers', runs };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const line = (name, run) => `${name}: ${String(run.aiVersions)}/${String(run.players)} AI versions, ${String(run.modelUnavailable)}x MODEL_UNAVAILABLE, upstream peak ${String(run.upstreamPeak)}/${String(run.slots)}, wait median ${String(run.waitMedianMs)} ms, max ${String(run.waitMaxMs)} ms`;
  for (const [name, run] of Object.entries(runs)) console.log(line(name, run));
  const ok = (runs.burst === undefined || (runs.burst.aiVersions === players && runs.burst.modelUnavailable === 0 && runs.burst.upstreamPeak === Math.min(players, slots))) && (runs.overflow === undefined || (runs.overflow.modelUnavailable > 0 && runs.overflow.upstreamPeak <= slots && runs.overflow.refusedQuickVersion?.playable === true));
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((thrown) => {
    console.error(thrown);
    process.exitCode = 1;
  });
}
