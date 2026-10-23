/**
 * Slepý soud viditelnosti P56A (T12 na `audit-12.json`, T13 na zapečetěné sadě): je podmět a předmět věty ve hře
 * vidět? `play` publikuje každou větu na běžícím serveru, pustí robota („Show me how“) na 3 s hry ručními hodinami
 * sondy a vyfotí jen plátno (text stránky skrytý). `judge` pošle každý snímek soudci P37D (`ask`: Codex přes
 * předplatné, prázdný `mkdtemp` jen se `sheet.png`), který dostane jen slova hrdiny a protivníka (bez protivníka
 * věc, se kterou hrdina pracuje). `report` složí obě strany do jednoho souboru. Soudce táhne TS slovník, proto
 * `node --experimental-strip-types --import ./scripts/ts-paths.mjs` před každým příkazem níž.
 *
 *   node evals/play/p56a/visible.mjs play --base http://127.0.0.1:3121 --set evals/play/p56a/audit-12.json --out <dir> [--gpu] [--spec]
 *   node evals/play/p56a/visible.mjs judge --dir <dir> [--judge codex|claude]
 *   node evals/play/p56a/visible.mjs report --a <dir> --b <dir> --set evals/play/p56a/audit-12.json --out evals/play/p56a/visible-dev.json [--a-commit <sha>] [--b-commit <sha>] [--setup <text>]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask } from '../../../scripts/p37d/judge-sheet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

/** 3 s hry při 60 Hz arkády. */
export const PLAY_TICKS = 180;

/** Slova, která má soudce ve hře najít: hrdina (podmět) a protivník, bez protivníka věc věty. Věta bez obou nemá co soudit. */
export function nounsOf(sentence) {
  return [sentence.hero, sentence.foe ?? sentence.item].filter((noun) => typeof noun === 'string' && noun !== '');
}

export function questionOf(nouns) {
  return `The attached image is one frame of a small 3D video game, 3 seconds into play; all page text is hidden, so judge only what the 3D scene shows. First describe in one sentence what the scene shows (scene). Then, for each of these words in this order: ${nouns.map((noun) => `"${noun}"`).join(', ')} – say whether something in the scene clearly depicts it (visible) and what you took for it, or what is there instead (seenAs). visible = true only when a figure or object in the scene would be recognised as that thing by someone who was not told what to look for; a coin, a token, a plain ball or block, a different animal or character, or something too small to make out is false. Reply only with the JSON the schema asks for.`;
}

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scene', 'nouns'],
  properties: {
    scene: { type: 'string' },
    nouns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['noun', 'visible', 'seenAs'],
        properties: { noun: { type: 'string' }, visible: { type: 'boolean' }, seenAs: { type: 'string' } },
      },
    },
  },
};

/** Viditelnost slov z odpovědi soudce, v pořadí `nouns`; slovo, které soudce vynechal, vidět není. */
export function verdictOf(nouns, answer) {
  const said = new Map((answer?.nouns ?? []).map((item) => [String(item.noun).toLowerCase(), item]));
  const per = nouns.map((noun, index) => {
    const item = said.get(noun.toLowerCase()) ?? answer?.nouns?.[index];
    return { noun, visible: item?.visible === true, seenAs: item?.seenAs ?? null };
  });
  return { all: per.length > 0 && per.every((item) => item.visible), nouns: per };
}

// Soudce vidí jen scénu: název, věta i HUD by mu napověděly (vzor `scripts/play-fidelity.mjs`).
const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);

function args() {
  const out = { _: [] };
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].startsWith('--')) out._.push(list[i]);
    else out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
  }
  return out;
}

/**
 * Robot hraje jako v klipu P45A: ruční hodiny sondy (`byHand`), takže 3 s jsou 3 s hry i na pomalém stroji. Hra bez
 * sondy arkády (mřížka) se pustí ťukem sondy a fotí po 3 s skutečného času s `robot: false`.
 */
async function snap(page, base, versionId, file) {
  await page.goto(`${base}/play/${versionId}`);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  const robot = await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 }).then(() => true, () => false);
  let state = null;
  if (robot) {
    await page.evaluate(() => window.__playShell.byHand(true));
    await page.getByTestId('play-pause').click();
    await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
    state = await page.evaluate(async (count) => {
      let last = null;
      for (let step = 0; step < count; step += 1) {
        last = window.__playShell.tickByHand();
        if (last.runState !== 'running') break;
      }
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return last;
    }, PLAY_TICKS);
  } else {
    await page.evaluate(() => window.__playShell?.start());
    await page.waitForTimeout((PLAY_TICKS * 1000) / 60);
  }
  await page.addStyleTag(SCENE_ONLY);
  await page.waitForTimeout(300);
  // P58A: obdélníky hrdiny, cíle a položek věty v záběru (`FrameProbe`), ze kterých T2 čte „příliš malé“.
  const frame = await page.evaluate(() => window.__playFrame?.() ?? null);
  await page.screenshot({ path: file });
  return { robot, tick: state?.tick ?? null, runState: state?.runState ?? null, frame: frame === null ? null : { width: frame.width, height: frame.height, hero: frame.hero, target: frame.target, items: frame.items } };
}

async function play(options) {
  const base = options.base ?? 'http://127.0.0.1:3121';
  const out = resolve(ROOT, options.out);
  mkdirSync(out, { recursive: true });
  const sentences = readJson(resolve(ROOT, options.set)).sentences;
  const { chromium } = createRequire(import.meta.url)('@playwright/test');
  const angle = options.gpu === true ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ args: angle });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    for (const sentence of sentences) {
      const record = join(out, `${sentence.id}.json`);
      if (existsSync(record)) continue;
      const started = Date.now();
      const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text }) });
      const created = await response.json();
      if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
      const draftMs = Date.now() - started;
      const game = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
      const roles = game.spec.roles ?? [];
      errors.length = 0;
      const shot = await snap(page, base, created.versionId, join(out, `${sentence.id}.png`));
      const row = {
        id: sentence.id,
        text: sentence.text,
        nouns: nounsOf(sentence),
        versionId: created.versionId,
        draftMs,
        readBy: game.origin?.readBy ?? 'keywords',
        genre: game.spec.genre === undefined ? null : `${game.spec.genre.id}.${game.spec.genre.mode}`,
        title: game.spec.title ?? null,
        hero: roles.find((role) => role.kind === 'player')?.label ?? null,
        roles: roles.filter((role) => role.kind !== 'player').map((role) => `${role.kind}:${role.label}`),
        ...shot,
        pageErrors: [...errors],
        // P58A T2: modely rolí počítá `scripts/p58a/why-unseen.mjs` ze stejného specu, jaký kreslil server.
        ...(options.spec === true ? { spec: game.spec } : {}),
      };
      writeJson(record, row);
      console.log(`${sentence.id} ${row.readBy} ${draftMs} ms hero ${row.hero} robot ${shot.robot ? shot.tick : 'no'} errors ${row.pageErrors.length}`);
    }
  } finally {
    await browser.close();
  }
}

/** Odpověď podle `SCHEMA` – soudce Claude ji vrací v textu, ne souborem. */
export const isVisibleAnswer = (value) => typeof value?.scene === 'string' && Array.isArray(value.nouns);

/** `--judge claude` (P58A): Opus 5.5 tam, kde by Codex přetekl denní strop; soudce se zapíše do odpovědi. */
async function judge(options) {
  const dir = resolve(ROOT, options.dir);
  const by = options.judge ?? 'codex';
  const schemaFile = join(dir, 'visible-schema.json');
  writeJson(schemaFile, SCHEMA);
  const ids = readdirSync(dir).filter((file) => /^[\w-]+\.json$/.test(file) && !file.endsWith('.answer.json') && file !== 'visible-schema.json').map((file) => file.slice(0, -'.json'.length)).sort();
  for (const id of ids) {
    const answerFile = join(dir, `${id}.answer.json`);
    if (existsSync(answerFile)) continue;
    const row = readJson(join(dir, `${id}.json`));
    const asked = await ask(join(dir, `${id}.png`), schemaFile, answerFile, questionOf(row.nouns), by, isVisibleAnswer);
    // Ztráta přihlášení nebo vyčerpaný limit: zastavit, díra není „nevidím“.
    if (!existsSync(answerFile)) throw new Error(`judge ${id}: no answer (exit ${asked?.code}) ${asked?.stderr ?? ''}`);
    const answer = readJson(answerFile);
    writeJson(answerFile, { ...answer, judge: by });
    const verdict = verdictOf(row.nouns, answer);
    console.log(`${id} ${verdict.all ? 'seen' : 'missed'} ${verdict.nouns.map((item) => `${item.noun}=${item.visible ? 'yes' : `no (${item.seenAs})`}`).join(' ')} ${asked.seconds} s`);
  }
}

function sideOf(dir, sentences) {
  const rows = sentences.map((sentence) => {
    const row = readJson(join(dir, `${sentence.id}.json`));
    const answer = readJson(join(dir, `${sentence.id}.answer.json`));
    return { ...row, scene: answer.scene, ...verdictOf(row.nouns, answer) };
  });
  const nouns = rows.flatMap((row) => row.nouns);
  return { seen: rows.filter((row) => row.all).length, of: rows.length, nounsSeen: nouns.filter((item) => item.visible).length, nounsOf: nouns.length, readByModel: rows.filter((row) => row.readBy === 'model').length, rows };
}

function report(options) {
  const sentences = readJson(resolve(ROOT, options.set)).sentences;
  // Bez `--a` jen strana B (T13: zapečetěná sada, soudce jen nad P56A).
  const a = options.a === undefined ? null : sideOf(resolve(ROOT, options.a), sentences);
  const b = sideOf(resolve(ROOT, options.b), sentences);
  const target = Number(options.target ?? 10);
  const strip = (side) => (side === null ? null : { seen: side.seen, of: side.of, nounsSeen: side.nounsSeen, nounsOf: side.nounsOf, readByModel: side.readByModel });
  const result = {
    schema: 'p56a-visible.v1',
    set: options.set,
    question: 'blind judge (scripts/p37d/judge-sheet.mjs ask: Codex on the subscription, empty mkdtemp with only sheet.png) sees every noun of the sentence: hero (subject) and foe, or the item when the sentence names no foe',
    frame: `canvas only, page text hidden, 1280x800, robot ("Show me how") after ${PLAY_TICKS} ticks (3 s of play) on the probe's hand clock`,
    setup: options.setup ?? null,
    a: a === null ? null : { commit: options['a-commit'] ?? null, side: 'before P56A, no sentence reader', ...strip(a) },
    b: { commit: options['b-commit'] ?? null, side: 'P56A with the sentence reader', ...strip(b) },
    target: `B sees both nouns in >= ${target}/${sentences.length}`,
    met: b.seen >= target,
    rows: sentences.map((sentence, index) => {
      const side = (row) => ({ readBy: row.readBy, genre: row.genre ?? null, title: row.title, hero: row.hero, roles: row.roles, robot: row.robot, tick: row.tick, scene: row.scene, nouns: row.nouns, all: row.all });
      return { id: sentence.id, text: sentence.text, ...(a === null ? {} : { a: side(a.rows[index]) }), b: side(b.rows[index]) };
    }),
  };
  writeJson(resolve(ROOT, options.out), result);
  console.log(`visible: ${a === null ? '' : `A ${a.seen}/${a.of} (nouns ${a.nounsSeen}/${a.nounsOf}), `}B ${b.seen}/${b.of} (nouns ${b.nounsSeen}/${b.nounsOf}, read by model ${b.readByModel}) target ${target} ${result.met ? 'met' : 'missed'} -> ${options.out}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  const command = options._[0];
  if (command === 'play') await play(options);
  else if (command === 'judge') await judge(options);
  else if (command === 'report') report(options);
  else throw new Error('usage: visible.mjs play|judge|report …');
}
