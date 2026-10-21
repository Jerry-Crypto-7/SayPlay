#!/usr/bin/env node
/**
 * Slepý soud P56C (T14): řetěz mikroher proti jedné hře téže věty, obě strany z téhož buildu a serveru.
 *
 * - **řetěz** – `POST /api/play/games {sentence}`: věty z `final.json` server pošle do řetězu sám (`chainOrSingle`);
 * - **jedna hra** – `chainOrSingle` přebité na `single`: návrh ze slov jako v route (`draftGameSpecWithMeta(věta, 1)`)
 *   publikovaný `POST {spec}` (semínko z hashe specu, ne věty – jediný rozdíl proti cestě jedné hry v route).
 *
 * Klip každé strany má `FRAMES` snímků jen plátna a hraje ho robot publikace: jedna hra rovnoměrně přes celý běh
 * robota (`byHand` + „Show me how“ jako `paceClip`), řetěz přes všechna kola (`demoTo` sondy `ChainPlay`, snímky po
 * kolech úměrně délce kola, aspoň jeden na kolo). Soudce P45 (`pairwise`, Codex, prázdný `mkdtemp` jen se `sheet.png`),
 * strana vlevo losem `pure-rand` (`JUDGE_SEED`). Soudce bez odpovědi = zapsané přeskočení, ne remíza.
 *
 *   node evals/play/p56c/judge.mjs --set holdout --out evals/play/p56c/judge.json [--base http://127.0.0.1:3156] [--software]
 *   node evals/play/p56c/judge.mjs --set dev --only d01,d02 --out <soubor> [--no-judge]   (nanečisto; holdout se neotvírá)
 *
 * `--set holdout` čte věty z `final.json`, který zapsal `holdout.measure.ts` při jediném otevření sady – soudce pečeť
 * sám neotevírá – a po soudu zapíše `final.md`. Snímky a listy leží v `evals/play/fidelity/runs/` (gitignored).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const RUNS = join(ROOT, 'evals', 'play', 'fidelity', 'runs');

/** Snímků v klipu každé strany – jako nejvýš `PACE.maxFrames` klipu průběhu P45. */
export const FRAMES = 8;
export const JUDGE_SEED = 56014;
/** Brána T14: podíl výher řetězu z rozhodnutých párů (remíza není rozhodnutá ani výhra). */
export const TARGET = 0.7;
/** Strop tiků průchodu jedné hry (`ARCADE_LIMITS.maxTicks` je 5 400). */
const TICK_CAP = 6000;

export const QUESTION = `The attached image shows two small 3D video games side by side, each played by the same robot player. Game A is the left column, game B the right column. Rows go down in time: eight frames spread evenly from the start to the end of each game's play. Page text is hidden, so judge only what the 3D scenes show. Which one would you rather keep playing, and which shows more different games? Pick the game that wins on both together; answer "tie" only when neither is better. Reply only with the JSON the schema asks for: winner = "A", "B" or "tie"; why = one or two sentences naming what you see in each game.`;

// Soudce vidí jen scénu: text stránky (název, karta se slovesem, HUD) by mu napověděl.
const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };

/** Tiky snímků jedné hry: středy `frames` stejných úseků běhu robota 0..`end`. */
export function evenTicks(end, frames = FRAMES) {
  return Array.from({ length: frames }, (_, k) => Math.max(1, Math.round(((k + 0.5) * end) / frames)));
}

/** Tiky snímků řetězu po kolech: počet úměrně délce kola (největší zbytek), aspoň jeden na kolo; v kole jako `evenTicks`. */
export function chainTicks(lengths, frames = FRAMES) {
  const total = lengths.reduce((sum, ticks) => sum + ticks, 0);
  const quota = lengths.map((ticks) => (ticks / total) * frames);
  const counts = quota.map((share) => Math.max(1, Math.floor(share)));
  const sum = () => counts.reduce((all, count) => all + count, 0);
  const rest = (round) => quota[round] - counts[round];
  const rounds = lengths.map((_, round) => round);
  while (sum() < frames) counts[rounds.reduce((best, round) => (rest(round) > rest(best) ? round : best))] += 1;
  while (sum() > frames) counts[rounds.filter((round) => counts[round] > 1).reduce((worst, round) => (rest(round) < rest(worst) ? round : worst))] -= 1;
  return lengths.map((ticks, round) => evenTicks(ticks, counts[round]));
}

function args() {
  const out = {};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
  return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const round3 = (value) => Math.round(value * 1000) / 1000;

export async function publish(base, body) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await response.json().catch(() => null);
  if (!response.ok || typeof created?.versionId !== 'string') throw new Error(`POST /api/play/games → ${String(response.status)} ${JSON.stringify(created).slice(0, 200)}`);
  return created.versionId;
}

export async function gameOf(base, id) {
  const body = await (await fetch(`${base}/api/play/games/${id}`, { cache: 'no-store' })).json();
  return body.game ?? body;
}

async function shot(page, path, index) {
  const file = `${path}-${String(index + 1)}.png`;
  await page.screenshot({ path: file });
  return basename(file);
}

async function openChain(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__playShell?.demoTo === 'function', undefined, { timeout: 60_000 });
}

/** Kolo `round` se otevřelo (karta doběhla), nebo řetěz skončil. */
const roundOpen = (page, round) =>
  page.waitForFunction((at) => window.__playShell.outcome() !== 'running' || (window.__playShell.card() === 0 && window.__playShell.round() === at), round, { timeout: 60_000 });

/**
 * Klip řetězu: první průchod robotem změří délku každého kola, druhý (nová stránka) fotí plánované tiky. Robot kola
 * převezme kolo hned po kartě (`demoTo(0)`), scéna se postaví, zatímco hraje, a `demoTo(tik)` ho dotočí na snímek.
 */
export async function chainClip(page, url, path) {
  await openChain(page, url);
  const rounds = [];
  for (let round = 0; ; round += 1) {
    await roundOpen(page, round);
    const end = await page.evaluate(() => window.__playShell.demoTo(Number.POSITIVE_INFINITY));
    if (end === null) break;
    rounds.push({ ticks: end.tick, outcome: end.runState });
  }
  const plan = chainTicks(rounds.map((round) => round.ticks));
  await openChain(page, url);
  await page.addStyleTag(SCENE_ONLY);
  const frames = [];
  for (const [round, ticks] of plan.entries()) {
    await roundOpen(page, round);
    if ((await page.evaluate(() => window.__playShell.demoTo(0))) === null) break;
    await page.waitForTimeout(400);
    for (const tick of ticks) {
      const now = await page.evaluate(async (to) => {
        const step = window.__playShell.demoTo(to);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return step;
      }, tick);
      if (now === null || now.round !== round) break;
      frames.push(await shot(page, path, frames.length));
    }
    await page.evaluate(() => window.__playShell.demoTo(Number.POSITIVE_INFINITY));
  }
  return { rounds, plan, frames, outcome: await page.evaluate(() => window.__playShell.outcome()) };
}

/** Robot jedné hry na ručních hodinách sondy, jako `paceClip` v `play-fidelity.mjs`. */
async function openSingle(page, url) {
  await page.goto(url);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 });
  await page.evaluate(() => window.__playShell.byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
}

const ticksByHand = (page, count) =>
  page.evaluate(async (steps) => {
    let last = null;
    for (let step = 0; step < steps; step += 1) {
      last = window.__playShell.tickByHand();
      if (last.runState !== 'running') break;
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return last;
  }, count);

/** Klip jedné hry: první průchod najde konec běhu robota, druhý fotí `evenTicks` přes celý běh. */
async function singleClip(page, url, path) {
  await openSingle(page, url);
  const end = await ticksByHand(page, TICK_CAP);
  const ticks = evenTicks(end.tick);
  await openSingle(page, url);
  await page.addStyleTag(SCENE_ONLY);
  const frames = [];
  let tick = 0;
  for (const target of ticks) {
    const now = await ticksByHand(page, target - tick);
    tick = now?.tick ?? target;
    frames.push(await shot(page, path, frames.length));
  }
  return { endTick: end.tick, outcome: end.runState, ticks, frames };
}

/** List pro soudce: sloupec A vlevo, B vpravo, řádky jsou snímky v čase; popisky řádků neutrální (číslo snímku). */
export async function sheet(page, left, right, path) {
  const rows = Math.max(left.length, right.length);
  const cell = (file) => (file === undefined ? '<div class="none"></div>' : `<img src="data:image/png;base64,${readFileSync(file).toString('base64')}">`);
  const body = Array.from({ length: rows }, (_, row) => `<tr><td class="t">${String(row + 1)}</td><td>${cell(left[row])}</td><td>${cell(right[row])}</td></tr>`).join('');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;font:600 28px Arial,sans-serif;color:#111">
<table style="border-spacing:16px 8px"><tr><td></td><th>Game A</th><th>Game B</th></tr>${body}</table>
<style>img,.none{width:480px;height:300px;display:block;border:2px solid #111}.none{background:#9a9a9a}.t{font-size:18px;width:40px}</style></body></html>`);
  await page.screenshot({ path, fullPage: true });
}

/** Věty soudu: holdout = řádky `final.json` poslané do řetězu (pečeť už otevřelo měření), dev = `--only` z `dev.json`. */
function sentencesOf(set, only) {
  if (set === 'holdout') {
    if (!existsSync(join(HERE, 'holdout-opened.json')) || !existsSync(join(HERE, 'final.json'))) throw new Error('run holdout.measure.ts first – the judge never opens the sealed set itself');
    return readJson(join(HERE, 'final.json')).rows.filter((row) => row.route === 'chain');
  }
  if (typeof only !== 'string') throw new Error('--set dev needs --only <ids> (a dry run, not a measurement)');
  const ids = new Set(only.split(','));
  return readJson(join(HERE, 'dev.json')).sentences.filter((sentence) => ids.has(sentence.id));
}

function summaryOf(pairs) {
  const count = (winner) => pairs.filter((pair) => pair.winner === winner).length;
  const chainWins = count('chain');
  const singleWins = count('single');
  const ties = count('tie');
  const decided = chainWins + singleWins;
  const leftWins = pairs.filter((pair) => pair.winner === pair.left).length;
  return {
    n: pairs.length,
    chainWins,
    singleWins,
    ties,
    decided,
    chainShareDecided: decided === 0 ? null : round3(chainWins / decided),
    chainShareAll: pairs.length === 0 ? null : round3(chainWins / pairs.length),
    leftWinShare: decided === 0 ? null : round3(leftWins / decided),
  };
}

const share = ({ hit, of }) => `${String(hit)}/${String(of)}`;

/** `final.md`: měření holdoutu (`final.json`) a slepý soud (`judge.json`). */
function finalMd(final, judged) {
  const { summary, gates } = final;
  const s = judged.summary;
  const pct = (part) => (part.of === 0 ? '–' : `${String(Math.round((part.hit / part.of) * 100))} %`);
  const metJudge = judged.skipped ? 'přeskočeno' : s.chainShareDecided !== null && s.chainShareDecided >= TARGET ? 'splněno' : 'nesplněno';
  const byId = new Map(final.rows.map((row) => [row.id, row]));
  const lines = [
    '# P56C T14 – zapečetěná sada: řetěz proti jedné hře',
    '',
    `Sada \`holdout.json\` (40 vět nezávislého autora, SHA \`${final.sha256.slice(0, 8)}…\`) otevřena jednou ${final.openedAt.slice(0, 10)} na \`${final.commit}\` (\`holdout.measure.ts\`); slepý soud \`judge.mjs\` na \`${judged.commit}\`. Nic se podle ní neladilo a dál je to jen dev sada.`,
    '',
    '## Výsledek',
    '',
    '| Brána | Cíl | Výsledek | |',
    '|---|---|---|---|',
    `| slepý soud: řetěz vyhraje z rozhodnutých párů | ≥ ${String(TARGET)} | ${judged.skipped ? '–' : `${String(s.chainWins)}/${String(s.decided)} = ${String(s.chainShareDecided)}`} | ${metJudge} |`,
    `| ≥ ${String(gates.minControls)} ovládání v řetězu | ≥ 80 % řetězů | ${share(summary.chains.controls)} (${pct(summary.chains.controls)}) | ${summary.chains.controls.hit >= 0.8 * summary.chains.controls.of ? 'splněno' : 'nesplněno'} |`,
    `| \`verifyChain\` bez chyby | 100 % | ${share(summary.chains.verified)} | ${summary.chains.verified.hit === summary.chains.verified.of ? 'splněno' : 'nesplněno'} |`,
    `| délka ${String(gates.seconds.min)}–${String(gates.seconds.max)} s | 100 % | ${share(summary.chains.length)} | ${summary.chains.length.hit === summary.chains.length.of ? 'splněno' : 'nesplněno'} |`,
    '',
    judged.skipped
      ? `Soud přeskočen: ${judged.reason}`
      : `Soud: ${String(s.n)} párů, řetěz ${String(s.chainWins)}, jedna hra ${String(s.singleWins)}, remíza ${String(s.ties)}; řetěz ze všech párů ${String(s.chainShareAll)} (remíza jako nevýhra). Levý sloupec vyhrál ${String(s.leftWinShare)} rozhodnutých párů (poziční zkreslení soudce).${judged.notChain.length > 0 ? ` Bez páru (server větu nepostavil jako řetěz): ${judged.notChain.join(', ')}.` : ''}`,
    '',
    '## Podíl vět poslaných do řetězu (`chainOrSingle`)',
    '',
    '| Rodina | řetěz |',
    '|---|---|',
    ...Object.entries(summary.routed).map(([family, part]) => `| \`${family}\` | ${share(part)} |`),
    '',
    '## Páry',
    '',
    '| id | rodina | větve | kola řetězu | jedna hra | vlevo | vítěz | proč (soudce) |',
    '|---|---|---|---|---|---|---|---|',
    ...judged.pairs.map((pair) => {
      const row = byId.get(pair.id);
      return `| ${pair.id} | ${row?.family ?? '?'} | ${row?.reasons.join(', ') ?? '?'} | ${pair.chainKeys.join(' → ')} | ${pair.singleGenre ?? '?'} | ${pair.left} | ${pair.winner} | ${String(pair.why).replaceAll('|', '/').replaceAll('\n', ' ')} |`;
    }),
    '',
    '## Jak se měřilo',
    '',
    `- Obě strany z téhož buildu a serveru (\`next start\`). Řetěz = \`POST {sentence}\` (rozhodne server). Jedna hra = \`chainOrSingle\` přebité na \`single\`: \`draftGameSpecWithMeta(věta, 1)\` jako v route, publikované \`POST {spec}\` – semínko světa se tak bere z hashe specu místo věty.`,
    `- Klip: ${String(FRAMES)} snímků jen plátna na stranu, hraje robot publikace. Jedna hra rovnoměrně přes celý běh robota, řetěz přes všechna kola úměrně délce kola, aspoň jeden snímek na kolo. Karty se slovesem a HUD jsou skryté.`,
    `- Soudce Codex přes \`ask\` (\`scripts/p37d/judge-sheet.mjs\`): prázdný \`mkdtemp\` jen se \`sheet.png\`, strana vlevo losem \`pure-rand\` xoroshiro128plus(${String(JUDGE_SEED)}). Otázka: „${QUESTION}“`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = args();
  const set = typeof options.set === 'string' ? options.set : 'holdout';
  const base = typeof options.base === 'string' ? options.base : 'http://127.0.0.1:3156';
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : join(HERE, 'judge.json'));
  const sentences = sentencesOf(set, options.only);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const run = typeof options.run === 'string' ? options.run : `p56c-t14-${set}`;
  const runs = { chain: `${run}-chain`, single: `${run}-single` };
  for (const dir of Object.values(runs)) mkdirSync(join(RUNS, dir), { recursive: true });

  const { genreOfSpec, pairwise } = await import('../../../scripts/play-fidelity.mjs');
  const { ask } = await import('../../../scripts/p37d/judge-sheet.mjs');
  const { draftGameSpecWithMeta } = await import('../../../src/play/draft/index.ts');
  const { loadRapier } = await import('../../../src/play/arcade/physics/world.ts');
  await loadRapier();

  const { chromium } = createRequire(import.meta.url)('@playwright/test');
  const angle = options.software === true ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-gl=angle', '--use-angle=d3d11'];
  const browser = await chromium.launch({ args: angle });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const sentence of sentences) {
      const chainFile = join(RUNS, runs.chain, `${sentence.id}.json`);
      if (!existsSync(chainFile)) {
        const versionId = await publish(base, { sentence: sentence.text });
        const game = await gameOf(base, versionId);
        const keys = game.chain?.rounds.map((round) => round.key) ?? null;
        const clip = keys === null ? null : await chainClip(page, `${base}/play/${versionId}`, join(RUNS, runs.chain, sentence.id));
        writeJson(chainFile, { id: sentence.id, versionId, keys, pace: clip });
        console.log(`${sentence.id} chain ${keys === null ? 'NOT A CHAIN' : `${keys.join(' > ')} · ${String(clip.frames.length)} frames · ${clip.outcome}`}`);
      }
      const singleFile = join(RUNS, runs.single, `${sentence.id}.json`);
      if (!existsSync(singleFile)) {
        const meta = draftGameSpecWithMeta(sentence.text, 1);
        const versionId = await publish(base, { spec: meta.spec });
        const game = await gameOf(base, versionId);
        const clip = await singleClip(page, `${base}/play/${versionId}`, join(RUNS, runs.single, sentence.id));
        const cell = meta.genre === null ? null : `${meta.genre.genre}.${meta.genre.mode}`;
        writeJson(singleFile, { id: sentence.id, versionId, cell, genre: genreOfSpec(game.spec), chain: game.chain !== undefined, pace: clip });
        console.log(`${sentence.id} single ${cell ?? genreOfSpec(game.spec)} · end ${String(clip.endTick)} (${clip.outcome}) · ${String(clip.frames.length)} frames`);
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }

  const notChain = sentences.filter((sentence) => readJson(join(RUNS, runs.chain, `${sentence.id}.json`)).keys === null).map((sentence) => sentence.id);
  const head = { schema: 'p56c-judge.v1', set, base, commit, a: { run: runs.single, side: 'single game (chainOrSingle forced to single)' }, b: { run: runs.chain, side: 'chain of microgames' }, seed: JUDGE_SEED, frames: FRAMES, question: QUESTION, target: `chain wins >= ${String(TARGET)} of decided pairs`, notChain };
  let judged;
  if (options['no-judge'] === true) {
    judged = { ...head, skipped: true, reason: '--no-judge (dry run)', pairs: [], summary: summaryOf([]) };
  } else {
    try {
      const page = await chromium.launch().then((composer) => composer.newPage({ viewport: { width: 1100, height: 800 } }).then((p) => ({ composer, p })));
      let verdict;
      try {
        verdict = await pairwise(
          { a: runs.single, b: runs.chain, seed: JUDGE_SEED, out: join(RUNS, `${run}-pairwise.json`), runsDir: RUNS, 'a-commit': commit, 'b-commit': commit, concurrency: 1 },
          { ask: (sheetFile, schemaFile, answerFile) => ask(sheetFile, schemaFile, answerFile, QUESTION), compose: (left, right, path) => sheet(page.p, left, right, path) },
        );
      } finally {
        await page.composer.close();
      }
      const pairs = verdict.pairs.map((pair) => {
        const chain = readJson(join(RUNS, runs.chain, `${pair.id}.json`));
        const single = readJson(join(RUNS, runs.single, `${pair.id}.json`));
        const side = (run) => (run === 'b' ? 'chain' : run === 'a' ? 'single' : 'tie');
        return { id: pair.id, chainKeys: chain.keys, singleGenre: single.cell ?? single.genre, left: side(pair.left), winner: side(pair.winner), why: pair.why };
      });
      const summary = summaryOf(pairs);
      judged = { ...head, skipped: false, summary, met: summary.chainShareDecided !== null && summary.chainShareDecided >= TARGET, pairs };
    } catch (error) {
      judged = { ...head, skipped: true, reason: error.message.slice(0, 400), pairs: [], summary: summaryOf([]) };
    }
  }
  writeJson(out, judged);
  console.log(judged.skipped ? `judge skipped: ${judged.reason}` : `judge: chain ${String(judged.summary.chainWins)}/${String(judged.summary.decided)} decided (${String(judged.summary.chainShareDecided)}, target ${String(TARGET)}) ties ${String(judged.summary.ties)} -> ${out}`);
  if (set === 'holdout') writeFileSync(join(HERE, 'final.md'), finalMd(readJson(join(HERE, 'final.json')), judged));
}

if (isMain) await main();
