#!/usr/bin/env node
/**
 * Prvních 10 s porotce (P58C T5): co porotce na `/play` uvidí a za jak dlouho může hrát.
 *
 *   node scripts/p58c/first-impression.mjs --base http://127.0.0.1:3187 [--runs 3] [--raw D:/caches/p58c/first-impression]
 *     [--out evals/play/p58c/first-impression.json] [--sheets evals/play/p58c/first-impression] [--skip-judges]
 *     [--gate-from <starší .json>]
 *
 * Tři profily (Pixel 7 a iPhone 15 na WebKitu jako telefony `e2e/p56b-first-frame.spec.ts`, desktop Chrome), každý běh
 * ve studeném kontextu prohlížeče (prázdná cache i úložiště = první návštěva):
 * - `fcpMs` – první vykreslený obsah (`first-contentful-paint`),
 * - `firstTapMs` – od navigace do prvního ťuku na první kartu nápadu, který větu opravdu vloží (před hydratací nic),
 * - `makeToPlayableMs` – od ťuku na „Make it!“ do prvního vstupu, který hra přijala (`data-input-at`, jako `play-chain`).
 * Server se před měřením zahřeje (první požadavek `next start` staví stránku líně), měří se klient, ne studený server.
 *
 * Film: snímky v ~0 (první obsah), 2, 5 a 10 s od navigace, každý ze svého studeného běhu (snímek stránku zdrží);
 * „rychlý porotce“ čte do 2 s, pak ťukne na první kartu, za 0,5 s na „Make it!“ a hraje ťukáním (desktop mezerníkem)
 * každých 0,8 s. WebKit na Windows po
 * zmenšení plátna (pokles kvality) plátno nesloží na obrazovku (`webkit.md`), proto film iPhonu běží při hustotě 1,
 * kde se plátno nezmenšuje. Snímky jdou do listu a list třem slepým soudcům (`ask` z `scripts/p37d/judge-sheet.mjs`:
 * prázdný adresář, `sheet.png`): Codex a Opus jako porotce, Opus jako hráč 13+.
 *
 * Ztráty: kategorie ze všech odpovědí sečtené přes soudce a profily, seřazené podle odhadnutých ztracených sekund
 * (víc soudců = víc sekund), u každé počet soudců, kteří ji jmenovali. Brána: `gate` (návrh) a s `--gate-from`
 * i `gateMet` proti bráně staršího výstupu.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium, devices, webkit } from '@playwright/test';
import sharp from 'sharp';

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Soudce (`judge-sheet.mjs`) táhne moduly `.ts` – stejně jako on se skript pustí znovu se `--experimental-strip-types`.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

export const PROFILES = {
  // Bez zpomalení CPU jako `p56b-first-frame` a `play-chain`: 4× z `p35-perf` je měrka FPS a se softwarovou grafikou
  // Playwrightu natáhla „Make it!“ → hra na 21 s, 40 s a přes minutu (23. 10.) – start skutečného telefonu to neukazuje.
  pixel7: { label: 'Pixel 7, Chrome', seen: 'Android phone', type: chromium, device: 'Pixel 7' },
  iphone15: { label: 'iPhone 15, WebKit (Windows)', seen: 'iPhone', type: webkit, device: 'iPhone 15', filmScale: 1 },
  desktop: { label: 'Desktop Chrome 1280x720', seen: 'laptop', type: chromium, device: 'Desktop Chrome' },
};

/** Věta, kterou zahřátí serveru postaví stránku hry (první požadavek `next start` ji staví líně). */
const WARM_SENTENCE = 'a cat jumps over boxes';

export const JUDGES = {
  'codex-juror': { judge: 'codex', role: 'a hackathon jury member with 50 projects to review today and about 30 seconds for each' },
  'opus-juror': { judge: 'claude', role: 'a hackathon jury member with 50 projects to review today and about 30 seconds for each' },
  'opus-player': { judge: 'claude', role: 'a 14-year-old who got this link in a group chat and usually scrolls TikTok' },
};

export const CATEGORIES = ['slow-first-screen', 'unclear-purpose', 'unclear-next-step', 'too-much-text', 'waiting-to-play', 'unclear-controls', 'broken-or-blank', 'other'];

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['understood', 'first_action', 'losses', 'verdict'],
  properties: {
    understood: { type: 'boolean' },
    first_action: { type: 'string' },
    losses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'category', 'seconds', 'note'],
        properties: { frame: { type: 'integer' }, category: { type: 'string', enum: CATEGORIES }, seconds: { type: 'number' }, note: { type: 'string' } },
      },
    },
    verdict: { type: 'string' },
  },
};

const isAnswer = (value) => typeof value?.understood === 'boolean' && typeof value.first_action === 'string' && Array.isArray(value.losses) && typeof value.verdict === 'string';

const FILM_AT = [0, 2000, 5000, 10_000];
const GAME_URL = /\/play\/[a-f0-9]+(\?|$)/;
const PLAY_EVERY_MS = 800;

const now = (page) => page.evaluate(() => performance.now());
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Chromium s grafickou kartou jako `scripts/measure/time-to-playable.mjs`: softwarová grafika (výchozí bez hlavy)
 * dusí stránku s hrou ve feedu a klik i snímek na ní trvají sekundy – telefon ani notebook porotce grafiku má. */
const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

async function open(profile, scale) {
  const browser = await profile.type.launch(profile.type === chromium ? { args: GPU_ARGS } : {});
  const options = { ...devices[profile.device] };
  if (scale !== undefined) options.deviceScaleFactor = scale;
  const context = await browser.newContext(options);
  const page = await context.newPage();
  if (profile.cpuThrottle) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottle });
  return { browser, page, touch: options.hasTouch === true };
}

const press = (locator, touch) => (touch ? locator.tap() : locator.click());

/** Ťuk do hry (desktop mezerník); vrací epoch ms prvního přijatého vstupu, nebo `null`. */
async function play(page, touch) {
  const stage = page.getByTestId('arcade-stage');
  if (touch) await stage.tap({ force: true, timeout: 2000 }).catch(() => {});
  else await page.keyboard.press('Space');
  const at = await stage.getAttribute('data-input-at', { timeout: 500 }).catch(() => null);
  return at === null ? null : Number(at);
}

/** Jeden studený běh: první obsah, první funkční ťuk, „Make it!“ → první přijatý vstup. */
async function measureRun(profile, base) {
  const { browser, page, touch } = await open(profile);
  try {
    await page.goto(`${base}/play`, { waitUntil: 'commit' });
    const pick = page.locator('[data-testid^=play-pick-]').first();
    const field = page.getByTestId('play-sentence');
    await pick.waitFor({ timeout: 60_000 });
    let firstTapMs = null;
    for (let attempt = 0; attempt < 600 && firstTapMs === null; attempt += 1) {
      const at = await now(page);
      await press(pick, touch);
      if ((await field.inputValue()) !== '') firstTapMs = at;
    }
    const fcpMs = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
    const created = page.waitForResponse((response) => response.url().endsWith('/api/play/games') && response.request().method() === 'POST', { timeout: 90_000 });
    const makeAt = await now(page);
    await press(page.getByTestId('play-create'), touch);
    const status = (await created).status();
    // Na `/play` hraje i feed – vstup se měří až ve hře z věty.
    await page.waitForURL(GAME_URL, { timeout: 90_000 });
    await page.getByTestId('arcade-stage').waitFor({ timeout: 90_000 });
    let inputAt = null;
    for (let attempt = 0; attempt < 600 && inputAt === null; attempt += 1) inputAt = await play(page, touch);
    const makeToPlayableMs = inputAt === null ? null : await page.evaluate(([stamp, from]) => stamp - performance.timeOrigin - from, [inputAt, makeAt]);
    return { fcpMs: round(fcpMs), firstTapMs: round(firstTapMs), makeToPlayableMs: round(makeToPlayableMs), created: status };
  } finally {
    await browser.close();
  }
}

/**
 * Jeden snímek filmu: studený běh cesty rychlého porotce až do `shotAt` ms od navigace a jediný snímek obrazovky
 * na konci. Snímek (i video) stránku na sekundy zdrží – kdyby jich běh dělal víc, každý by posunul všechno za ním.
 * `shotAt` 0 = hned po prvním obsahu (v 0 s je obrazovka ještě bílá).
 */
async function frame(profile, base, file, shotAt) {
  const { browser, page, touch } = await open(profile, profile.filmScale);
  // Lokální server bez živého modelu by autorskou verzi hned vzdal a ukázal toast, který porotce na nasazení v prvních
  // 10 s neuvidí (režisér tam běží desítky sekund) – stav verze proto odpovídá jako běžící režisér.
  await page.route('**/api/play/games/*/upgrade', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { status: 'pending', deadlineAt: new Date(Date.now() + 270_000).toISOString() } }) : route.continue(),
  );
  const actions = [];
  try {
    await page.goto(`${base}/play`, { waitUntil: 'commit' });
    if (shotAt === 0) await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0, undefined, { timeout: 60_000, polling: 20 });
    // Hodiny na straně skriptu: `evaluate` na stránce, která zrovna hydratuje, by čas odpovídal až za stovky ms.
    const origin = await page.evaluate(() => performance.timeOrigin);
    const since = async () => Date.now() - origin;
    const field = page.getByTestId('play-sentence');
    const step = async (ms) => {
      const left = ms - (await since());
      if (left > 0) await pause(left);
      return (await since()) < shotAt;
    };
    // Klik bez čekání Playwrightu na „stabilní“ prvek: na stránce, která zrovna kreslí hru feedu, to čekání trvá
    // sekundy, porotce kartu vidí a ťukne hned. Před hydratací klik nic neudělá a zkouší se znovu.
    const hit = (locator) => locator.dispatchEvent('click');
    if (shotAt > 0 && (await step(FILM_AT[1]))) {
      while ((await field.inputValue()) === '' && (await since()) < shotAt) await hit(page.locator('[data-testid^=play-pick-]').first());
      if ((await field.inputValue()) !== '') actions.push({ at: round(await since()), what: 'tapped the first suggestion card (it fills the text box)' });
    }
    if (actions.length === 1 && (await step((await since()) + 500))) {
      actions.push({ at: round(await since()), what: 'tapped "Make it!"' });
      await hit(page.getByTestId('play-create'));
      while ((await since()) < shotAt - PLAY_EVERY_MS / 2) {
        const tick = await since();
        if (GAME_URL.test(page.url()) && (await page.getByTestId('arcade-stage').count()) > 0 &&(await play(page, touch)) !== null && actions.length === 2) actions.push({ at: round(tick), what: `first ${touch ? 'tap' : 'key press'} the game accepted (then one every 0.8 s)` });
        await step(tick + PLAY_EVERY_MS);
      }
    }
    await step(shotAt);
    const at = await since();
    await page.screenshot({ path: file, scale: 'css' });
    return { at: round(at), file, actions };
  } finally {
    await browser.close();
  }
}

/** Film rychlého porotce: snímky v `FILM_AT`, každý ze svého studeného běhu; akce z nejdelšího běhu. */
async function film(profile, base, dir, name) {
  const frames = [];
  for (const [index, shotAt] of FILM_AT.entries()) frames.push(await frame(profile, base, path.join(dir, `${name}-${String(index + 1)}.png`), shotAt));
  return { frames, actions: frames.at(-1).actions };
}

/** List: snímky vedle sebe (telefon) nebo 2×2 (desktop), nad každým pruh s pořadím a časem. */
async function sheet(frames, file) {
  const first = await sharp(frames[0].file).metadata();
  const wide = first.width > first.height;
  const w = wide ? 960 : Math.min(first.width, 412);
  const h = Math.round((first.height * w) / first.width);
  const band = 44;
  const cols = wide ? 2 : frames.length;
  const rows = Math.ceil(frames.length / cols);
  const gap = 12;
  const layers = [];
  for (const [index, frame] of frames.entries()) {
    const left = (index % cols) * (w + gap);
    const top = Math.floor(index / cols) * (h + band + gap);
    const text = `${String(index + 1)}  ·  ${(frame.at / 1000).toFixed(1)} s`;
    layers.push({ input: Buffer.from(`<svg width="${w}" height="${band}"><rect width="100%" height="100%" fill="#1d1a17"/><text x="12" y="30" font-family="Arial" font-size="24" font-weight="700" fill="#fff">${text}</text></svg>`), left, top });
    layers.push({ input: await sharp(frame.file).resize(w, h).toBuffer(), left, top: top + band });
  }
  await sharp({ create: { width: cols * w + (cols - 1) * gap, height: rows * (h + band) + (rows - 1) * gap, channels: 3, background: '#ffffff' } }).composite(layers).png().toFile(file);
}

export function question(role, deviceLabel, frames, actions) {
  const times = frames.map((frame, index) => `${String(index + 1)} = ${(frame.at / 1000).toFixed(1)} s`).join(', ');
  const done = actions.map((action) => `at ${(action.at / 1000).toFixed(1)} s ${action.what}`).join('; ');
  return (
    `You are ${role}. You open a web app you have never seen, on a ${deviceLabel}. The attached image shows ${String(frames.length)} screenshots of your screen, numbered, with the time since you opened the link (${times}). ` +
    `Between the screenshots a fast tester did exactly this: ${done || 'nothing'}. Judge only from what is visible. Reply only with the JSON the schema asks for: ` +
    'understood = true if within the first 2 seconds you would know what this app is and what to do first; first_action = what you would do first, one sentence; ' +
    `losses = up to 3 moments where you would lose time, get confused or lose interest, each with frame (1-${String(frames.length)}), category (${CATEGORIES.join(', ')}), seconds (your estimate of time lost, 0-10) and note (one sentence on what you see); ` +
    'verdict = one sentence: would you keep playing past 10 seconds, and why.'
  );
}

const round = (value) => (value === null || value === undefined ? null : Math.round(value));

export function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Kategorie ztrát přes všechny odpovědi: sekundy sečtené (víc soudců = víc sekund), počet soudců a profilů. */
export function rankLosses(judged) {
  const byCategory = new Map();
  for (const [profile, answers] of Object.entries(judged)) {
    for (const [judge, answer] of Object.entries(answers)) {
      for (const loss of answer?.losses ?? []) {
        const entry = byCategory.get(loss.category) ?? { category: loss.category, seconds: 0, judges: new Set(), profiles: new Set(), notes: [] };
        entry.seconds += Math.max(0, Math.min(10, loss.seconds));
        entry.judges.add(judge);
        entry.profiles.add(profile);
        entry.notes.push(`${profile}/${judge} #${String(loss.frame)}: ${loss.note}`);
        byCategory.set(loss.category, entry);
      }
    }
  }
  return [...byCategory.values()]
    .map((entry) => ({ ...entry, seconds: Math.round(entry.seconds * 10) / 10, judges: [...entry.judges], profiles: [...entry.profiles] }))
    .sort((a, b) => b.seconds - a.seconds || b.judges.length - a.judges.length);
}

/** Brána staršího výstupu proti novému měření: každá mez v `gate.metrics` (p50 ms na profil) a soudci „rozumím“. */
export function checkGate(gate, result) {
  const misses = [];
  for (const [profile, limits] of Object.entries(gate.metrics ?? {})) {
    for (const [metric, limit] of Object.entries(limits)) {
      const value = result.profiles[profile]?.p50?.[metric];
      if (typeof value !== 'number' || value > limit) misses.push(`${profile}.${metric} p50 ${String(value)} > ${String(limit)}`);
    }
  }
  for (const [profile, understood] of Object.entries(result.understood)) {
    if (understood.yes < (gate.understoodAtLeast ?? 0)) misses.push(`${profile} understood ${String(understood.yes)}/${String(understood.of)} < ${String(gate.understoodAtLeast)}`);
  }
  return { met: misses.length === 0, misses };
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://127.0.0.1:3187' },
      runs: { type: 'string', default: '3' },
      raw: { type: 'string', default: 'D:/caches/p58c/first-impression' },
      out: { type: 'string', default: 'evals/play/p58c/first-impression.json' },
      sheets: { type: 'string', default: 'evals/play/p58c/first-impression' },
      'skip-judges': { type: 'boolean', default: false },
      'gate-from': { type: 'string' },
    },
  });
  const base = values.base;
  mkdirSync(values.raw, { recursive: true });
  mkdirSync(values.sheets, { recursive: true });
  await fetch(`${base}/play`);
  const warm = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: WARM_SENTENCE }) });
  await fetch(`${base}${(await warm.json()).url}`);

  const result = { date: new Date().toISOString(), base, runs: Number(values.runs), profiles: {}, film: {}, judges: {}, understood: {}, losses: [] };
  for (const [name, profile] of Object.entries(PROFILES)) {
    const runs = [];
    for (let run = 0; run < result.runs; run += 1) {
      const measured = await measureRun(profile, base);
      console.log(name, run + 1, JSON.stringify(measured));
      runs.push(measured);
    }
    const p50 = Object.fromEntries(['fcpMs', 'firstTapMs', 'makeToPlayableMs'].map((metric) => [metric, median(runs.map((one) => one[metric]))]));
    result.profiles[name] = { label: profile.label, device: profile.device, cpuThrottle: profile.cpuThrottle ?? 1, runs, p50 };
    const shot = await film(profile, base, values.raw, name);
    const sheetFile = path.join(values.raw, `${name}-sheet.png`);
    await sheet(shot.frames, sheetFile);
    await sharp(sheetFile).jpeg({ quality: 80 }).toFile(path.join(values.sheets, `${name}.jpg`));
    result.film[name] = { frames: shot.frames.map((frame) => frame.at), actions: shot.actions, sheet: path.join(values.sheets, `${name}.jpg`).replaceAll('\\', '/') };
    console.log(name, 'film', JSON.stringify(result.film[name]));
  }

  if (!values['skip-judges']) {
    const { ask } = await import('../p37d/judge-sheet.mjs');
    const schemaFile = path.join(values.raw, 'answer-schema.json');
    writeFileSync(schemaFile, JSON.stringify(ANSWER_SCHEMA));
    for (const [name, profile] of Object.entries(PROFILES)) {
      result.judges[name] = {};
      const frames = result.film[name].frames.map((at) => ({ at }));
      for (const [judgeName, judge] of Object.entries(JUDGES)) {
        const answerFile = path.join(values.raw, `${name}-${judgeName}.json`);
        const run = await ask(path.join(values.raw, `${name}-sheet.png`), schemaFile, answerFile, question(judge.role, profile.seen, frames, result.film[name].actions), judge.judge, isAnswer);
        let answer = null;
        try {
          answer = JSON.parse(readFileSync(answerFile, 'utf8'));
        } catch {
          console.log(name, judgeName, 'no answer', run.code, run.stderr);
        }
        result.judges[name][judgeName] = answer;
        console.log(name, judgeName, `${String(run.seconds)} s`, JSON.stringify(answer));
      }
      const answers = Object.values(result.judges[name]).filter((answer) => answer !== null);
      result.understood[name] = { yes: answers.filter((answer) => answer.understood).length, of: answers.length };
    }
    result.losses = rankLosses(result.judges);
  }

  if (values['gate-from'] !== undefined) {
    const before = JSON.parse(readFileSync(values['gate-from'], 'utf8'));
    result.gate = before.gate;
    result.gateMet = checkGate(before.gate, result);
    copyFileSync(values['gate-from'], `${values.raw}/before.json`);
  }
  writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log('wrote', values.out);
}

if (isMain) await main();
