#!/usr/bin/env node
/**
 * Slepý soud P46G T9: dvanáct vět (`evals/play/p46g/sentences.json`), snímek „před“
 * (`evals/play/p46g/before/`, build T1 `2c95c85c`) proti snímku „po“
 * (`evals/play/p46g/after/`) – stejná hra ve stejném tiku ukázky robota
 * (`scripts/play-look-shots.mjs`). Dvojice leží vedle sebe bez popisků, kdo je
 * vlevo, losuje jeden stream `pure-rand` ze seedu zapsaného do výsledku. Soudce
 * (Opus 5.5, `claude -p`, jediný nástroj Read, `--safe-mode`) dostane dvojici jako
 * `sheet.png` sám v čerstvém prázdném `mkdtemp` adresáři, který je jeho cwd – jméno
 * souboru ani cesta mu stranu neprozradí. Odpověď je jeden pevný řádek
 * `VERDICT: LEFT|RIGHT – důvod`; nečitelná odpověď se přeptá jednou.
 *
 *   node scripts/play-p46g-blind.mjs judge [--seed 46009] [--work D:/tmp/p46g-blind] [--concurrency 3]
 *   node scripts/play-p46g-blind.mjs sheet
 *   node scripts/play-p46g-blind.mjs judge --dir evals/play/p54b --pass-at 15 --work D:/tmp/p54b-blind   (P54B T15: věty žánrů, desktop i telefon)
 *
 * `judge` zapíše `evals/play/p46g/judge.json` (projde, když „po“ vyhraje aspoň 10 z 12);
 * listy dvojic a odpovědi leží ve `--work` mimo repo a hotová odpověď se nepřeptává.
 * `sheet` složí `evals/play/p46g/sheet-all.png` pro majitele: všech 12 dvojic
 * s popisky „before“ / „after“ a větou.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { uniformInt } from 'pure-rand/distribution/uniformInt';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P46G = join(ROOT, 'evals', 'play', 'p46g');
const require = createRequire(import.meta.url);

export const SEED = 46009;
export const PASS_AT = 10;
export const MODEL = 'claude-opus-5-5';
/** `claude.cmd` jen volá nativní `claude.exe` vedle sebe (jako `scripts/p37d/judge-sheet.mjs`). */
const CLAUDE = process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude';

export const question = (sentence) =>
  `First open sheet.png in the current directory with the Read tool. It shows two screenshots side by side, LEFT and RIGHT, of a small 3D video game made from the request: "${sentence}". Page text is hidden, so judge only the 3D scenes. Which side looks more like a believable, immersive, clear game place for this request – a place that looks like the setting the request names, that you could believe you are in, and where the path or ground you play on and the characters are easy to read? End your reply with exactly one line in this form and nothing after it:\nVERDICT: LEFT – <one short reason>\nor\nVERDICT: RIGHT – <one short reason>`;

/** Kdo je vlevo v každé dvojici: jeden stream `pure-rand` ze seedu v pořadí vět; 0 = „před“ vlevo (jako P39). */
export function sides(seed, count) {
  const rng = xoroshiro128plus(seed);
  return Array.from({ length: count }, () => (uniformInt(rng, 0, 1) === 0 ? 'before' : 'after'));
}

/** Poslední řádek `VERDICT: LEFT|RIGHT – důvod` v odpovědi; `undefined`, když tam není. */
export function parseVerdict(text) {
  const lines = [...String(text).matchAll(/^\W*VERDICT\W*:?\W*(LEFT|RIGHT)\b[\s*–—:|.-]*(.*)$/gim)];
  const last = lines.at(-1);
  return last ? { verdict: last[1].toUpperCase(), reason: last[2].replace(/\*+$/, '').trim() } : undefined;
}

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function args() {
  const out = { _: [] };
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
    else out._.push(list[i]);
  }
  return out;
}

/**
 * Dvojice bez popisků: dva snímky vedle sebe, mezi nimi bílý pruh. Desktop 960×600; telefon na výšku
 * (P54B T15) vysoký 1200 px v poměru stran – oříznutí na 960×600 by soudci nechalo jen pruh ze středu.
 */
async function pair(leftFile, rightFile, out) {
  const sharp = require('sharp');
  const { width: sourceWidth, height: sourceHeight } = await sharp(leftFile).metadata();
  const [width, height] = sourceWidth >= sourceHeight ? [960, 600] : [Math.round((1200 * sourceWidth) / sourceHeight), 1200];
  const [left, right] = await Promise.all([leftFile, rightFile].map((file) => sharp(file).resize(width, height).png().toBuffer()));
  await sharp({ create: { width: width * 2 + 24, height, channels: 3, background: '#ffffff' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: width + 24, top: 0 }])
    .png()
    .toFile(out);
}

/** Jedna otázka: čerstvý prázdný adresář jen se `sheet.png` jako cwd soudce, odpověď je text `result`. */
function ask(sheet, prompt) {
  const cwd = mkdtempSync(join(os.tmpdir(), 'judge-'));
  copyFileSync(sheet, join(cwd, 'sheet.png'));
  const argv = ['-p', '--safe-mode', '--strict-mcp-config', '--tools', 'Read', '--allowedTools', 'Read', '--no-session-persistence', '--model', MODEL, '--output-format', 'json', prompt];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(CLAUDE, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += error.message; });
    child.on('close', (code) => {
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch { /* zůstane v tempu */ }
      let text = stdout;
      try {
        const envelope = JSON.parse(stdout);
        text = typeof envelope.result === 'string' ? envelope.result : stdout;
      } catch { /* necháme syrový výstup */ }
      done({ code, seconds: Math.round((Date.now() - started) / 100) / 10, text: text.trim(), stderr: stderr.trim().slice(-400) });
    });
  });
}

/** Odpovědi na dvojice `<work>/<key>-pair.png` do `<key>-answer.json`; hotová odpověď se nepřeptává. */
async function answerAll(jobs, work, concurrency) {
  const queue = jobs.filter(({ key }) => !existsSync(join(work, `${key}-answer.json`)));
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const attempts = [];
      // Nečitelná odpověď se přeptá jednou (stejná otázka, nový prázdný adresář).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const run = await ask(join(work, `${job.key}-pair.png`), job.prompt);
        const parsed = parseVerdict(run.text);
        attempts.push({ code: run.code, seconds: run.seconds, text: run.text.slice(-1500), stderr: run.stderr, parsed: parsed ?? null });
        if (parsed) break;
      }
      writeJson(join(work, `${job.key}-answer.json`), { attempts });
      const last = attempts.at(-1);
      console.log(`${job.key}: ${last.parsed ? `${last.parsed.verdict} – ${last.parsed.reason}` : `no verdict (exit ${last.code}) ${last.stderr || last.text.slice(-200)}`} [${attempts.length} ask, ${last.seconds} s]`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

export const ANCHOR_QUESTION =
  'First open sheet.png in the current directory with the Read tool. It shows two screenshots side by side, LEFT and RIGHT, each from a different 3D mobile game. Interface text is cropped away, so judge only the game scene. Which one looks like a finished game from an app store – polished art, lighting and materials and readable characters, rather than an unfinished prototype? End your reply with exactly one line in this form and nothing after it:\nVERDICT: LEFT – <one short reason>\nor\nVERDICT: RIGHT – <one short reason>';

/**
 * `anchor --anchor D:/tmp/p56b-ref --dir evals/play/p56b --ours before-phone --set p56b --out <file>` (P56B T2):
 * kotva „levného vzhledu“ – náš snímek telefonu proti snímku hotové hry z obchodu. `--count` (10)
 * prvních vět sady × každá hra (podadresář `--anchor` s `crop/`); referenční snímek hry se střídá
 * po řadě. Stranu losuje `sides` ze seedu (`before` = náš vlevo). Výsledek: podíl výher naší strany.
 */
async function anchor(options) {
  const refRoot = resolve(String(options.anchor));
  const dir = resolve(ROOT, typeof options.dir === 'string' ? options.dir : 'evals/play/p56b');
  const ours = typeof options.ours === 'string' ? options.ours : 'before-phone';
  const set = typeof options.set === 'string' ? options.set : 'p56b';
  const setFile = set === 'p56b' ? join(ROOT, 'evals', 'play', 'p56b', 'sentences.json') : join(ROOT, 'evals', 'play', 'p46g', `${set}.json`);
  const count = Number(options.count ?? 10);
  const seed = typeof options.seed === 'string' ? Number(options.seed) : 56021;
  const work = resolve(typeof options.work === 'string' ? options.work : 'D:/tmp/p56b-anchor');
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : join(dir, 'anchor.json'));
  const concurrency = Number(options.concurrency ?? 3);
  mkdirSync(work, { recursive: true });
  const games = readdirSync(refRoot).filter((name) => existsSync(join(refRoot, name, 'crop'))).sort();
  const refs = Object.fromEntries(games.map((game) => [game, readdirSync(join(refRoot, game, 'crop')).filter((file) => file.endsWith('.png')).sort()]));
  const sentences = readJson(setFile).sentences.slice(0, count);
  const jobs = sentences.flatMap((sentence, index) => games.map((game) => ({ sentence, game, ref: refs[game][index % refs[game].length], key: `${ours}-${sentence.id}-${game}` })));
  const left = sides(seed, jobs.length);
  for (const [index, job] of jobs.entries()) {
    const own = join(dir, ours, `${job.sentence.id}.png`);
    if (!existsSync(own)) throw new Error(`${job.key}: missing ${own}`);
    const reference = join(refRoot, job.game, 'crop', job.ref);
    const file = join(work, `${job.key}-pair.png`);
    if (!existsSync(file)) await pair(left[index] === 'before' ? own : reference, left[index] === 'before' ? reference : own, file);
  }
  await answerAll(jobs.map((job) => ({ key: job.key, prompt: ANCHOR_QUESTION })), work, concurrency);
  const pairs = jobs.map((job, index) => {
    const parsed = readJson(join(work, `${job.key}-answer.json`)).attempts.at(-1).parsed;
    const oursSide = left[index] === 'before' ? 'LEFT' : 'RIGHT';
    return { id: job.sentence.id, game: job.game, reference: job.ref, oursSide, verdict: parsed?.verdict ?? null, reason: parsed?.reason ?? null, oursWon: parsed ? parsed.verdict === oursSide : null };
  });
  const totalOf = (list) => {
    const oursWins = list.filter((entry) => entry.oursWon === true).length;
    const answered = list.filter((entry) => entry.oursWon !== null).length;
    return { oursWins, refWins: answered - oursWins, unanswered: list.length - answered, of: list.length, share: answered === 0 ? null : Math.round((oursWins / answered) * 1000) / 1000 };
  };
  const result = {
    about: `Store-game anchor: our ${ours} shot vs a cropped store screenshot of a finished game, side by side without labels. See README.md.`,
    judgedAt: new Date().toISOString(),
    judge: { model: MODEL, how: 'claude -p --safe-mode --tools Read, one call per pair, sheet.png alone in a fresh empty mkdtemp dir as cwd; unparseable answer re-asked once', question: ANCHOR_QUESTION },
    order: { prng: 'pure-rand xoroshiro128plus + uniformInt(0, 1) per pair in sentence order, game after game; 0 = ours is LEFT', seed },
    ours: { dir: ours, set, sentences: sentences.map((sentence) => sentence.id) },
    references: refs,
    total: totalOf(pairs),
    byGame: Object.fromEntries(games.map((game) => [game, totalOf(pairs.filter((entry) => entry.game === game))])),
    leftShare: Math.round((pairs.filter((entry) => entry.verdict === 'LEFT').length / pairs.length) * 1000) / 1000,
    pairs,
  };
  writeJson(out, result);
  console.log(`ours wins ${result.total.oursWins} / ${result.total.of} (share ${result.total.share}), left chosen ${result.leftShare}`);
  console.log(`-> ${out}`);
}

/**
 * Kde leží snímky a které dvojice se soudí. Bez voleb sada P46G; `--dir evals/play/p54b`
 * (P54B T15) vezme věty žánrů (`--set genres`) a dvě dvojice adresářů, desktop
 * `before:after` a telefon `before-phone:after-phone` (`--pairs`), s prahem `--pass-at`
 * na každou dvojici zvlášť.
 */
function layout(options) {
  const dir = typeof options.dir === 'string' ? resolve(ROOT, options.dir) : P46G;
  const own = dir === P46G;
  const set = typeof options.set === 'string' ? options.set : own ? 'sentences' : 'genres';
  const pairs = typeof options.pairs === 'string' ? options.pairs : own ? 'before:after' : 'before:after,before-phone:after-phone';
  return {
    dir,
    sentences: readJson(join(ROOT, 'evals', 'play', 'p46g', `${set}.json`)).sentences,
    profiles: pairs.split(',').map((entry) => {
      const [before, after] = entry.split(':');
      return { before, after };
    }),
    passAt: typeof options['pass-at'] === 'string' ? Number(options['pass-at']) : PASS_AT,
  };
}

async function judge(options) {
  const { dir, sentences: base, profiles, passAt } = layout(options);
  const seed = typeof options.seed === 'string' ? Number(options.seed) : SEED;
  const work = resolve(typeof options.work === 'string' ? options.work : 'D:/tmp/p46g-blind');
  const concurrency = Number(options.concurrency ?? 3);
  mkdirSync(work, { recursive: true });
  // Jedna dvojice adresářů = jeden profil; id ve `work` nese profil, ať se odpovědi nepletou.
  const sentences = profiles.flatMap(({ before, after }) => base.map((sentence) => ({ ...sentence, key: profiles.length === 1 ? sentence.id : `${after}-${sentence.id}`, before, after })));
  const left = sides(seed, sentences.length);
  for (const [index, sentence] of sentences.entries()) {
    const files = [sentence.before, sentence.after].map((side) => join(dir, side, `${sentence.id}.png`));
    if (!files.every(existsSync)) throw new Error(`${sentence.key}: missing before or after shot`);
    const [before, after] = files;
    const file = join(work, `${sentence.key}-pair.png`);
    if (!existsSync(file)) await pair(left[index] === 'before' ? before : after, left[index] === 'before' ? after : before, file);
  }

  await answerAll(sentences.map((sentence) => ({ key: sentence.key, prompt: question(sentence.text) })), work, concurrency);

  const pairs = sentences.map((sentence, index) => {
    const { attempts } = readJson(join(work, `${sentence.key}-answer.json`));
    const parsed = attempts.at(-1).parsed;
    const afterSide = left[index] === 'after' ? 'LEFT' : 'RIGHT';
    return { id: sentence.id, ...(profiles.length === 1 ? {} : { profile: sentence.after }), sentence: sentence.text, afterSide, verdict: parsed?.verdict ?? null, reason: parsed?.reason ?? null, afterWon: parsed ? parsed.verdict === afterSide : null, asks: attempts.length };
  });
  const totalOf = (list) => {
    const afterWins = list.filter((entry) => entry.afterWon === true).length;
    return { afterWins, beforeWins: list.filter((entry) => entry.afterWon === false).length, unanswered: list.filter((entry) => entry.afterWon === null).length, of: list.length, passAt, pass: afterWins >= passAt };
  };
  const totals = profiles.map(({ after }) => ({ profile: after, ...totalOf(pairs.filter((entry) => entry.profile === undefined || entry.profile === after)) }));
  const result = {
    about: dir === P46G
      ? 'P46G T9 blind judgement: the same game at the same demo tick, before P46G (T1 2c95c85c, evals/play/p46g/before) and after (evals/play/p46g/after), side by side without labels. See README.md.'
      : `Blind judgement of ${profiles.map(({ before, after }) => `${before} vs ${after}`).join(' and ')}: the same game at the same demo tick, side by side without labels. See README.md.`,
    judgedAt: new Date().toISOString(),
    judge: { model: MODEL, how: 'claude -p --safe-mode --tools Read, one call per pair, sheet.png alone in a fresh empty mkdtemp dir as cwd; unparseable answer re-asked once', question: question('<sentence>') },
    order: { prng: 'pure-rand xoroshiro128plus + uniformInt(0, 1) per pair in sentence order, profile after profile; 0 = before is LEFT', seed },
    total: profiles.length === 1 ? totals[0] : totals,
    pairs,
  };
  writeJson(join(dir, 'judge.json'), result);
  for (const total of totals) console.log(`${total.profile}: after wins ${total.afterWins} / ${total.of} (pass at ${passAt})`);
  console.log(`-> ${join(dir, 'judge.json')}`);
}

const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** List pro majitele: dvě věty na řádek, nad každou věta, pod snímky s popiskem adresáře („before“ / „after“ …). */
async function sheet(options) {
  const { dir, sentences, profiles } = layout(options);
  const sideList = profiles.flatMap(({ before, after }) => [before, after]);
  const cell = (sentence) => `<div class="pair"><div class="text">${escape(sentence.text)}</div><div class="row">${sideList
    .map((side) => `<figure><img src="${dataUrl(join(dir, side, `${sentence.id}.png`))}"><figcaption>${side}</figcaption></figure>`)
    .join('')}</div></div>`;
  // Výška pevná, šířka podle snímku: desktop 16 : 10 i telefon na výšku ve stejné řadě.
  const html = `<!doctype html><html><head><style>
body{margin:0;padding:24px;background:#f4f4f2;font:600 26px Arial,sans-serif;color:#111}
.grid{display:grid;grid-template-columns:repeat(2,auto);gap:36px 48px}
.text{margin:0 0 10px}.row{display:flex;gap:12px}figure{margin:0}
img{height:375px;width:auto;display:block;border:2px solid #111}
figcaption{font:600 24px Arial,sans-serif;padding-top:6px}
</style></head><body><div class="grid">${sentences.map(cell).join('')}</div></body></html>`;
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 1200 } });
    await page.setContent(html);
    const width = await page.evaluate(() => document.querySelector('.grid').scrollWidth + 48);
    await page.setViewportSize({ width, height: 1200 });
    await page.screenshot({ path: join(dir, 'sheet-all.png'), fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(`sheet -> ${join(dir, 'sheet-all.png')}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  if (options._[0] === 'judge') await judge(options);
  else if (options._[0] === 'sheet') await sheet(options);
  else if (options._[0] === 'anchor') await anchor(options);
  else {
    console.error('usage: node scripts/play-p46g-blind.mjs judge|sheet|anchor [--dir evals/play/p54b] [--set genres] [--pairs before:after,before-phone:after-phone] [--pass-at 15] [--seed <n>] [--work <dir>] [--concurrency 3] [--anchor <ref dir> --ours before-phone --count 10 --out <file>]');
    process.exit(2);
  }
}
