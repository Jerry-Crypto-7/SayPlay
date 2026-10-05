#!/usr/bin/env node
/**
 * Slepý soud P39 T14: dvanáct vět, hra „před“ (build `88245889`, main před P39)
 * proti hře „po“ (HEAD). Každá strana běží na vlastním `next start` se živým
 * režisérem; snímky jsou jen plátno (text stránky skrytý), první snímek a snímek
 * po 3 s hry robota. Soudce (astra přes předplatné, `codex exec -i`) vidí list se
 * dvěma hrami „A“ a „B“ v prázdném adresáři jako `sheet.png` – jméno souboru ani
 * cesta mu stranu neprozradí. Kdo je vlevo, losuje `pure-rand` ze zapsaného seedu.
 *
 *   node scripts/play-p39-blind.mjs play  --before http://127.0.0.1:3150 --after http://127.0.0.1:3151 [--run <id>] [--only wolf,d12] [--gpu]
 *   node scripts/play-p39-blind.mjs judge [--run <id>] [--seed 39014] [--concurrency 2]
 *
 * Hotová věta (strana) se při dalším `play` přeskočí, hotová odpověď soudce se
 * nepřeptává. Snímky a listy leží v `evals/play/fidelity/runs/<id>/` (gitignored),
 * verdikt v `evals/play/p39/blind/verdict.json`.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'evals', 'play', 'fidelity', 'runs');
const VERDICT = join(ROOT, 'evals', 'play', 'p39', 'blind', 'verdict.json');
const { genreOfSpec } = await import('./play-fidelity.mjs');
const { ask } = await import('./p37d/judge-sheet.mjs');
const { assertNotTrainingDir } = await import('./assets/qa-astra.mjs');
const { xoroshiro128plus } = await import('pure-rand/generator/xoroshiro128plus');
const { uniformInt } = await import('pure-rand/distribution/uniformInt');

/** Dvanáct vět a proč je každá v sadě (výběr podle plánu P39 T14); id `dNN` / `sNNN` jsou z `evals/play/p30/dev.json`. */
export const SENTENCES = [
  { id: 'trigger', text: 'jumping and shooting game in the forest against animals', covers: ['trigger sentence', 'platformer', 'shoot in a platformer'] },
  { id: 'zombies', text: 'jump and shoot zombies in a graveyard', covers: ['platformer', 'shoot in a platformer'] },
  { id: 'drones', text: 'run and shoot drones on a highway', covers: ['runner', 'shoot in a runner'] },
  { id: 'mansion', text: 'collect coins, dodge ghosts and shoot bats in a haunted mansion', covers: ['shooter', 'three roles'] },
  { id: 'squirrel', text: 'a squirrel grabs acorns, dodges owls and throws pinecones at a fox', covers: ['throw', 'three roles'] },
  { id: 'wolf', text: 'a rabbit runs from a hungry wolf in a snowy forest', covers: ['arena', 'no model in the library (wolf drawn as dog)'] },
  { id: 's037', text: 'A space marine shoots alien bugs in a mining colony', covers: ['shooter'] },
  { id: 'd12', text: 'a goldfish swims through a sunken city dodging sharks', covers: ['voyage'] },
  { id: 'd10', text: 'a pirate duels a skeleton captain on a sinking ship', covers: ['duel'] },
  { id: 's006', text: 'A corgi runs through a park grabbing sausages and jumping over sprinklers', covers: ['runner', 'two roles'] },
  { id: 's002', text: 'A knight must collect three keys in a haunted castle while dodging ghosts.', covers: ['arena', 'two roles'] },
  { id: 's003', text: 'A hamster escaping a supermarket while a giant Roomba hunts me', covers: ['arena', 'chase'] },
];

export const SEED = 39014;
export const PLAY_TICKS = 180;

export const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'why'],
  properties: { winner: { type: 'string', enum: ['A', 'B', 'tie'] }, why: { type: 'string' } },
};

export const question = (sentence) =>
  `The attached image shows two small 3D video games, both made from the same request: "${sentence}". Game A is the left column, game B the right column. The top row is each game's first frame, the bottom row the same game after 3 seconds of play. Page text is hidden, so judge only what the 3D scenes show. Which game better shows what the request asks for: the things the request names are visible and each plays the role the request gives it (something to shoot, to dodge, to collect, to run from, to fight, to reach, to throw at), the place looks like the place named, and it is the kind of game asked for (jumping, running, shooting, swimming ...)? Answer "tie" only when neither is better. Reply only with the JSON the schema asks for: winner = "A", "B" or "tie"; why = one or two sentences naming what you see in each game.`;

/** Kdo je vlevo (A) v každé dvojici: jeden stream `pure-rand` ze seedu, losuje se v pořadí vět. */
export function sides(seed, count) {
  const rng = xoroshiro128plus(seed);
  return Array.from({ length: count }, () => (uniformInt(rng, 0, 1) === 0 ? 'before' : 'after'));
}

/** Odpověď soudce (A / B / tie) přeložená na stranu podle losu. */
export function winnerSide(winner, left) {
  if (winner === 'tie') return 'tie';
  const right = left === 'before' ? 'after' : 'before';
  return winner === 'A' ? left : right;
}

export function score(verdicts) {
  const count = (side) => verdicts.filter((verdict) => verdict.winnerSide === side).length;
  const newWins = count('after');
  return { newWins, ties: count('tie'), oldWins: count('before'), of: verdicts.length, pass: newWins >= 7, sameGame: verdicts.filter((verdict) => verdict.sameSpec).length };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const shaOf = (cwd) => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

function args() {
  const out = { _: [] };
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
    else out._.push(list[i]);
  }
  return out;
}

async function gameOf(base, id) {
  const body = await (await fetch(`${base}/api/play/games/${id}`, { cache: 'no-store' })).json();
  return body.game ?? body;
}

/** Publikace jako `runOne` v `play-fidelity.mjs`: rychlá verze, pak AI verze, když do 330 s přijde. */
async function publish(base, text) {
  const started = Date.now();
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: text }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`${base}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  let upgrade;
  for (;;) {
    await sleep(4000);
    upgrade = await (await fetch(`${base}/api/play/games/${created.versionId}/upgrade`, { cache: 'no-store' })).json();
    if (upgrade.status !== 'pending') break;
    if (Date.now() - started > 330_000) {
      upgrade = { status: 'timeout' };
      break;
    }
  }
  const versionId = upgrade.versionId ?? created.versionId;
  const spec = (await gameOf(base, versionId)).spec;
  return { base, draftId: created.versionId, versionId, version: upgrade.versionId ? 'ai' : 'quick', upgrade: upgrade.reason ?? upgrade.status, seconds: Math.round((Date.now() - started) / 1000), genre: genreOfSpec(spec), spec };
}

/** Počká na vlastní panorama hry (jako `envOf` v `play-fidelity.mjs`), ať snímek nese prostředí, které hráč uvidí. */
async function waitForEnv(base, id) {
  const until = Date.now() + 120_000;
  for (;;) {
    const response = await fetch(`${base}/api/play/games/${id}/env`, { cache: 'no-store' });
    const status = response.ok ? (await response.json()).status : `http ${response.status}`;
    if (status !== 'pending' || Date.now() > until) return status;
    await sleep(3000);
  }
}

const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };

/**
 * Dva snímky jen plátna: první snímek po načtení (hodiny stojí do prvního doteku)
 * a snímek po `PLAY_TICKS` tikách hry robota („Show me how“) odtikaných ručními
 * hodinami sondy jako `clip` v `play-fidelity.mjs`. Hra bez robota (mřížka) běží 3 s skutečného času.
 */
async function shots(page, game, path) {
  const env = await waitForEnv(game.base, game.versionId);
  await page.goto(`${game.base}/play/${game.versionId}`);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${path}-start-page.png` });
  await page.addStyleTag(SCENE_ONLY);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${path}-start.png` });

  await page.goto(`${game.base}/play/${game.versionId}`);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  const robot = await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  let tick = null;
  if (robot) {
    await page.evaluate(() => window.__playShell.byHand(true));
    await page.getByTestId('play-pause').click();
    await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
    await page.addStyleTag(SCENE_ONLY);
    tick = await page.evaluate(async (count) => {
      let state = null;
      for (let index = 0; index < count; index += 1) {
        state = window.__playShell.tickByHand();
        if (state.runState !== 'running') break;
      }
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return state?.tick ?? null;
    }, PLAY_TICKS);
  } else {
    await page.addStyleTag(SCENE_ONLY);
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: `${path}-play.png` });
  return { env, robot, tick };
}

async function play(options) {
  const runId = typeof options.run === 'string' ? options.run : `p39-blind-${new Date().toISOString().slice(0, 10)}`;
  const runDir = join(RUNS, runId);
  mkdirSync(runDir, { recursive: true });
  const bases = { before: options.before, after: options.after };
  if (typeof bases.before !== 'string' || typeof bases.after !== 'string') throw new Error('play needs --before <url> --after <url>');
  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  const angle = options.gpu === true ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ args: angle });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
    for (const sentence of SENTENCES.filter((entry) => only === null || only.has(entry.id))) {
      const todo = ['before', 'after'].filter((side) => !existsSync(join(runDir, `${sentence.id}-${side}.json`)));
      // Obě strany najednou: dvě volání režiséra v letu, víc předplatné neunese.
      const games = await Promise.all(todo.map((side) => publish(bases[side], sentence.text)));
      for (const [index, side] of todo.entries()) {
        const game = games[index];
        game.shots = await shots(page, game, join(runDir, `${sentence.id}-${side}`));
        writeJson(join(runDir, `${sentence.id}-${side}.json`), { id: sentence.id, text: sentence.text, side, ...game });
        console.log(`${sentence.id} ${side}: ${game.version} (${game.upgrade}) ${game.genre} ${game.seconds} s robot ${game.shots.robot ? `tick ${game.shots.tick}` : 'no'}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`play ${runId} -> ${runDir}`);
}

const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

/** List pro soudce: sloupec A vlevo, B vpravo, nahoře první snímek, dole po 3 s hry. Jen písmena, nic o straně. */
async function sheet(page, left, right, path) {
  const cell = (file) => `<img src="${dataUrl(file)}">`;
  const html = `<!doctype html><html><body style="margin:0;background:#fff;font:600 28px Arial,sans-serif;color:#111">
<table style="border-spacing:16px 10px"><tr><td></td><th>Game A</th><th>Game B</th></tr>
<tr><td style="font-size:18px;width:90px">first frame</td><td>${cell(`${left}-start.png`)}</td><td>${cell(`${right}-start.png`)}</td></tr>
<tr><td style="font-size:18px">after 3 s of play</td><td>${cell(`${left}-play.png`)}</td><td>${cell(`${right}-play.png`)}</td></tr></table>
<style>img{width:640px;height:400px;display:block;border:2px solid #111}</style></body></html>`;
  await page.setContent(html);
  await page.screenshot({ path, fullPage: true });
}

async function judge(options) {
  const runId = typeof options.run === 'string' ? options.run : `p39-blind-${new Date().toISOString().slice(0, 10)}`;
  const runDir = join(RUNS, runId);
  assertNotTrainingDir(runDir);
  const seed = typeof options.seed === 'string' ? Number(options.seed) : SEED;
  const concurrency = Number(options.concurrency ?? 2);
  const left = sides(seed, SENTENCES.length);
  const schemaFile = join(runDir, 'blind-schema.json');
  writeJson(schemaFile, QUESTION_SCHEMA);

  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
  try {
    for (const [index, sentence] of SENTENCES.entries()) {
      const right = left[index] === 'before' ? 'after' : 'before';
      const file = join(runDir, `${sentence.id}-sheet.png`);
      if (!existsSync(file)) await sheet(page, join(runDir, `${sentence.id}-${left[index]}`), join(runDir, `${sentence.id}-${right}`), file);
    }
  } finally {
    await browser.close();
  }

  const queue = SENTENCES.map((sentence, index) => ({ sentence, index })).filter(({ sentence }) => !existsSync(join(runDir, `${sentence.id}-answer.json`)));
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const run = await ask(join(runDir, `${job.sentence.id}-sheet.png`), schemaFile, join(runDir, `${job.sentence.id}-answer.json`), question(job.sentence.text));
      console.log(`${job.sentence.id}: codex exit ${run.code} in ${run.seconds} s${existsSync(join(runDir, `${job.sentence.id}-answer.json`)) ? '' : ` – no answer: ${run.stderr}`}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const verdicts = SENTENCES.map((sentence, index) => {
    const answer = readJson(join(runDir, `${sentence.id}-answer.json`));
    const runs = Object.fromEntries(['before', 'after'].map((side) => [side, readJson(join(runDir, `${sentence.id}-${side}.json`))]));
    const game = ({ version, upgrade, genre, spec, shots: { robot } }) => ({ version, upgrade, genre, roles: spec.roles.map((role) => `${role.kind}:${role.label}`), robot });
    // Stejná spec na obou stranách = táž hra; remíza je tam správná odpověď, P39 na ní nic nezměnil.
    const sameSpec = JSON.stringify(runs.before.spec) === JSON.stringify(runs.after.spec);
    return { id: sentence.id, sentence: sentence.text, covers: sentence.covers, left: left[index], winner: answer.winner, winnerSide: winnerSide(answer.winner, left[index]), why: answer.why, sameSpec, before: game(runs.before), after: game(runs.after) };
  });
  const before = readJson(join(runDir, `${SENTENCES[0].id}-before.json`)).base;
  const after = readJson(join(runDir, `${SENTENCES[0].id}-after.json`)).base;
  const result = {
    about: 'P39 T14 blind judgement: the same sentence as a game before P39 (main 88245889) and after (HEAD), judged side by side by Codex over the subscription. See README.md.',
    judgedAt: new Date().toISOString(),
    runId,
    builds: { before: { commit: '88245889', server: before }, after: { commit: shaOf(ROOT), server: after } },
    judge: { how: 'codex exec -i sheet.png in an empty mkdtemp dir, --output-schema {winner, why}; page text hidden, canvas only', question: question('<sentence>') },
    order: { prng: 'pure-rand xoroshiro128plus + uniformInt(0, 1) per pair in list order; 0 = before is A (left)', seed },
    score: score(verdicts),
    verdicts,
  };
  mkdirSync(dirname(VERDICT), { recursive: true });
  writeJson(VERDICT, result);
  const { newWins, ties, oldWins, of } = result.score;
  console.log(`new wins ${newWins} / ties ${ties} / old wins ${oldWins} of ${of} -> ${VERDICT}`);
}

if (isMain) {
  const options = args();
  if (options._[0] === 'play') await play(options);
  else if (options._[0] === 'judge') await judge(options);
  else {
    console.error('usage: node scripts/play-p39-blind.mjs play --before <url> --after <url> [--run <id>] [--gpu] | judge [--run <id>] [--seed <n>] [--concurrency 2]');
    process.exit(2);
  }
}
