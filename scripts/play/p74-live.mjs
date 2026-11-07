#!/usr/bin/env node
/**
 * P74 T2: zkušební produkce na emulovaných telefonech.
 *
 *   node scripts/play/p74-live.mjs ai --base <demoUrl ze submission.json> --out evals/play/p74
 *   node scripts/play/p74-live.mjs phones --base <url> --out evals/play/p74 [--only runner,flap] [--phones iphone,pixel]
 *
 * `ai`: pět nových vět (už použitá věta přijde z cache režiséra a změří 0 volání – paměť director-cache-skews-live-timing),
 * čas do rychlé hry (odpověď POST) a do AI verze (`GET …/upgrade` → `ready`), nejvýš 300 s na větu.
 * `phones`: každý živý žánr registru (`GENRES` mimo `ROUTE_PENDING`) jednou hrou na iPhonu 15 (WebKit, dotyk) a Pixelu 7
 * (Chromium, dotyk, CPU 4×, bez OpenXR): hra se načte, snímek uprostřed hry, verdikt robota `playWitness()`
 * (paměť handplay-drops-aim), pak výhra „rukou“ pošle výzvu a druhý kontext ji otevře. Hra se publikuje jednou
 * a oba telefony hrají totéž id. Výsledky se zapisují po každém řádku, pád běhu je neztratí.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const AI_SENTENCES = [
  { id: 'teacup', seed: 74001, text: 'a hamster in a teacup sails across a flooded kitchen collecting cherries' },
  { id: 'fireflies', seed: 74002, text: 'a lighthouse cat herds glowing fireflies into jars before dawn' },
  { id: 'snail', seed: 74003, text: 'an astronaut snail races across a moon made of cheese' },
  { id: 'cactus', seed: 74004, text: 'a grumpy cactus bounces tumbleweeds away from its desert flower' },
  { id: 'balcony', seed: 74005, text: 'a tiny robot waters seedlings on a windy balcony while pigeons try to eat them' },
];

/**
 * Jedna hra na žánr. Věty ověřené 7. 11. cestou POST bez čtečky (`draftGameSpecWithMeta`): rychlá verze dá ten žánr.
 * `merge` a `push` rychlá verze z věty nedá (klasifikátor je slyší, hraje se jiný žánr – zapisuje se, co přišlo);
 * `steal` a `arrows` nedá vůbec, ty jdou z ručního specu e2e. `stunt` je vypnutý (`ROUTE_PENDING`).
 */
export const GENRE_GAMES = [
  { genre: 'runner', text: 'a fox runs through a forest dodging logs and rocks' },
  { genre: 'platformer', text: 'a frog hops across platforms to reach the flag' },
  { genre: 'arena', text: 'Survive in an arena full of slimes.' },
  { genre: 'voyage', text: 'a squirrel pilot flies a leaf plane, drops acorns on targets and lands on a wobbly branch' },
  { genre: 'quest', text: 'a knight lights the torches in a dark castle' },
  { genre: 'shooter', text: 'zombie shooter in a mall' },
  { genre: 'throw', text: 'Throw snowballs at targets in a winter park' },
  { genre: 'timing', text: 'stack blocks as high as you can' },
  { genre: 'rhythm', text: 'tap to the beat with glowing tiles' },
  { genre: 'duel', text: 'a fox duels a kangaroo in a boxing ring' },
  { genre: 'flap', text: 'like flappy bird but underwater' },
  { genre: 'catch', text: 'a raccoon catches falling apples in a bucket' },
  { genre: 'whack', text: 'bonk the moles popping out of the golf course' },
  { genre: 'defense', text: 'a knight defends the castle gate from skeleton armies' },
  { genre: 'slice', text: 'slice flying fruit with a sword' },
  { genre: 'hop', text: 'a chicken hops across a busy road' },
  { genre: 'crowd', text: 'grow a crowd of runners and smash through the gates' },
  { genre: 'merge', text: 'merge two identical gems into a bigger gem' },
  { genre: 'push', text: 'a sumo cat pushes dogs off a rooftop' },
  { genre: 'survivor', text: 'a wizard survives endless waves of bats in a graveyard' },
  { genre: 'hole', text: 'a black hole that swallows a city, it gets bigger the more it eats' },
  { genre: 'steal', spec: 'e2e/fixtures/p66-steal-spec.json' },
  { genre: 'sort', text: 'sort the fruit into crates at the market stall' },
  { genre: 'arrows', spec: 'e2e/fixtures/p66-arrows-spec.json' },
  { genre: 'minigolf', text: 'short golf course on a farm, ball has to roll under the tractor and past bouncy hay bales to the hole' },
  { genre: 'railfps', text: 'Shoot the alien bugs from the back of a desert jeep as it speeds along' },
  { genre: 'buildshift', text: 'A chef flips burgers on a sizzling grill before the customers get angry' },
  { genre: 'drawsave', text: 'Bowling balls roll down a hill toward a tiny gnome and my lines have to stop them' },
];

const SEED = 74100;
const AI_LIMIT_MS = 300_000;

/** Přerušovaný `503 DISABLED` produkce (7. 11.) se počítá a zkusí znovu po 5 s, nejvýš třikrát – měří se hra, výpadek se zapíše. */
async function post(base, body) {
  let disabled = 0;
  let started = Date.now();
  let response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  while (response.status === 503 && disabled < 3) {
    disabled += 1;
    await sleep(5_000);
    started = Date.now();
    response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  const created = await response.json().catch(() => ({}));
  const quickMs = Date.now() - started;
  if (!created.versionId) throw new Error(`POST ${response.status} after ${disabled} retries ${JSON.stringify(created).slice(0, 200)}`);
  const game = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
  const spec = (game.game ?? game).spec ?? {};
  return { versionId: created.versionId, quickMs, started, disabled, chain: (game.game ?? game).chain !== undefined, specGenre: spec.genre?.id ?? null, control: spec.control ?? null, store: response.headers.get('x-play-store') };
}

/** Čeká na AI verzi: `GET …/upgrade` drží odpověď až 25 s, takže smyčka nebuší. */
async function upgrade(base, quick) {
  let last = null;
  while (Date.now() - quick.started < AI_LIMIT_MS) {
    const response = await fetch(`${base}/api/play/games/${quick.versionId}/upgrade`, { cache: 'no-store' });
    last = await response.json().catch(() => ({ status: `http-${response.status}` }));
    if (last.status === 'ready') return { status: 'ready', aiMs: Date.now() - quick.started, aiVersion: last.versionId };
    if (last.status !== 'pending') return { status: last.status, reason: last.reason ?? null, aiMs: null };
    await sleep(2_000);
  }
  return { status: 'timeout', reason: last?.status ?? null, aiMs: null };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

async function runAi(base, out) {
  const rows = [];
  for (const sentence of AI_SENTENCES) {
    const row = { id: sentence.id, text: sentence.text };
    try {
      const quick = await post(base, { sentence: sentence.text, seed: sentence.seed });
      Object.assign(row, { versionId: quick.versionId, quickMs: quick.quickMs, specGenre: quick.specGenre, chain: quick.chain, store: quick.store }, await upgrade(base, quick));
    } catch (error) {
      row.error = String(error).slice(0, 300);
    }
    rows.push(row);
    console.log(`${row.id}: quick ${row.quickMs ?? '?'} ms ${row.specGenre ?? ''}; AI ${row.status ?? 'error'}${row.reason ? ` (${row.reason})` : ''}${row.aiMs ? ` ${(row.aiMs / 1000).toFixed(1)} s` : ''}${row.error ? ` ! ${row.error}` : ''}`);
    writeFileSync(join(out, 'ai.json'), `${JSON.stringify({ base, measuredAt: new Date().toISOString(), rows }, null, 1)}\n`);
  }
  const ai = rows.filter((row) => row.status === 'ready').map((row) => row.aiMs);
  const summary = { quickOk: rows.filter((row) => row.versionId).length, aiReady: ai.length, medianQuickMs: median(rows.filter((row) => row.quickMs).map((row) => row.quickMs)), medianAiMs: median(ai) };
  writeFileSync(join(out, 'ai.json'), `${JSON.stringify({ base, measuredAt: new Date().toISOString(), summary, rows }, null, 1)}\n`);
  console.log(JSON.stringify(summary));
}

const PHONES = {
  iphone: { engine: 'webkit', device: 'iPhone 15', throttle: 1 },
  pixel: { engine: 'chromium', device: 'Pixel 7', throttle: 4 },
};

/** Karta ukázky robota a hláška poctivosti jsou měřicí šum; HUD zůstává. */
const MEASURING_ONLY = { content: '.play-demo-note, .play-honest { display: none !important; }' };
const ready = (page) => page.waitForFunction(() => window.__playShell !== undefined && document.querySelector('canvas') !== null, undefined, { timeout: 90_000 });

async function context(browsers, phone, devices, n) {
  const spec = PHONES[phone];
  // Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (vzor `play-share.spec.ts`).
  const ctx = await browsers[spec.engine].newContext({ ...devices[spec.device], hasTouch: true, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });
  const page = await ctx.newPage();
  if (spec.throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: spec.throttle });
  return { ctx, page };
}

async function playOne(browsers, devices, base, shots, game, phone, n) {
  const row = { genre: game.genre, phone, versionId: game.versionId, errors: [] };
  const { ctx, page } = await context(browsers, phone, devices, n);
  // Se dvěma rámci stacku (první řádek stacku opakuje zprávu): R5 (`i.x` na iPhonu, 1× z 28) bez nich nešla dohledat ani reprodukovat (0/30).
  page.on('pageerror', (error) => row.errors.push([error.message.slice(0, 160), ...(error.stack ?? '').split('\n').slice(1, 3).map((line) => line.trim().slice(0, 200))].join(' | ')));
  const loadStarted = Date.now();
  try {
    await page.goto(`${base}/play/${game.versionId}`, { timeout: 120_000 });
    await ready(page);
    row.loadMs = Date.now() - loadStarted;
    await page.addStyleTag(MEASURING_ONLY);
    const stage = page.getByTestId('arcade-stage').first();
    row.arcade = await page.evaluate(() => typeof window.__playShell.handPlay === 'function');
    row.stage = row.arcade ? await stage.getAttribute('data-control', { timeout: 5_000 }).catch(() => null) : 'grid';
    // Uprostřed hry: arkáda běží 2,5 s naostro (bez vstupu), mřížka dostane první dva tahy svědka.
    if (row.arcade) {
      await page.evaluate(() => window.__playShell.start());
      await sleep(2_500);
      // Souboj, poletování, rytmus, střílečka a stohování čekají na první dotek hráče: sonda je nepustí, ťuk ano.
      if (await page.getByTestId('play-first-prompt').isVisible().catch(() => false)) {
        const box = await stage.boundingBox();
        if (box !== null) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.6);
        row.tapped = true;
        await sleep(2_500);
      }
    } else {
      await page.evaluate(() => window.__playShell.start());
      await page.evaluate(() => window.__playShell.playWitness(2));
      await sleep(1_500);
    }
    row.shot = `${game.genre}-${phone}.jpg`;
    await page.screenshot({ path: join(shots, row.shot), type: 'jpeg', quality: 70, timeout: 60_000 });
    const witness = await page.evaluate(() => window.__playShell.playWitness());
    row.witness = witness.runState;
    // Výzva: jen lidský běh („rukou“) ji pošle; mřížka a prohraný běh otevřou v druhém kontextu holý odkaz.
    let dareId = null;
    if (row.arcade) {
      const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${game.versionId}/dare`) && response.request().method() === 'POST', { timeout: 20_000 }).catch(() => null);
      const hand = await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        return window.__playShell.handPlay('end');
      });
      row.hand = hand.runState;
      const response = hand.runState === 'won' ? await posted : null;
      if (response !== null) {
        row.dareStatus = response.status();
        dareId = (await response.json().catch(() => ({}))).dareId ?? null;
      }
    }
    const friend = await context(browsers, phone, devices, n + 100);
    try {
      await friend.page.goto(`${base}/play/${game.versionId}${dareId === null ? '' : `?via=share&dare=${dareId}`}`, { timeout: 120_000 });
      await friend.page.getByTestId(dareId === null ? 'play-goal' : 'play-dare-goal').first().waitFor({ timeout: 90_000 });
      row.friend = dareId === null ? 'link' : 'dare';
    } catch (error) {
      row.friend = `fail: ${String(error).split('\n')[0].slice(0, 120)}`;
    } finally {
      await friend.ctx.close();
    }
  } catch (error) {
    row.error = String(error).split('\n')[0].slice(0, 240);
    await page.screenshot({ path: join(shots, `${game.genre}-${phone}-error.jpg`), type: 'jpeg', quality: 60 }).catch(() => undefined);
  } finally {
    await ctx.close();
  }
  row.pass = row.error === undefined && row.witness === 'won' && (row.friend === 'link' || row.friend === 'dare');
  return row;
}

async function runPhones(base, out, options) {
  const shots = join(out, 'shots');
  mkdirSync(shots, { recursive: true });
  const file = join(out, 'phones.json');
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const phones = typeof options.phones === 'string' ? options.phones.split(',') : Object.keys(PHONES);
  const earlier = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { games: [], rows: [] };
  const games = earlier.games.filter((game) => only === null || !only.has(game.genre));
  const rows = earlier.rows.filter((row) => !(only === null || only.has(row.genre)) || !phones.includes(row.phone));
  const save = () => writeFileSync(file, `${JSON.stringify({ base, measuredAt: new Date().toISOString(), games, rows }, null, 1)}\n`);
  const { chromium, webkit, devices } = require('@playwright/test');
  const browsers = { chromium: await chromium.launch({ args: ['--disable-features=OpenXR'] }), webkit: await webkit.launch() };
  let n = 1;
  try {
    for (const entry of GENRE_GAMES.filter((item) => only === null || only.has(item.genre))) {
      let game;
      try {
        const body = entry.spec === undefined ? { sentence: entry.text, seed: SEED } : { spec: JSON.parse(readFileSync(join(ROOT, entry.spec), 'utf8')) };
        game = { genre: entry.genre, source: entry.spec === undefined ? 'sentence' : 'spec', text: entry.text ?? entry.spec, ...(await post(base, body)) };
      } catch (error) {
        game = { genre: entry.genre, source: entry.spec === undefined ? 'sentence' : 'spec', text: entry.text ?? entry.spec, error: String(error).slice(0, 240) };
      }
      delete game.started;
      games.push(game);
      for (const phone of phones) {
        const row = game.versionId === undefined ? { genre: entry.genre, phone, pass: false, error: game.error } : await playOne(browsers, devices, base, shots, game, phone, n);
        n += 1;
        rows.push(row);
        console.log(`${entry.genre} ${phone}: ${row.pass ? 'OK' : 'FAIL'} spec ${game.specGenre ?? '?'} stage ${row.stage ?? '?'} witness ${row.witness ?? '?'} hand ${row.hand ?? '-'} friend ${row.friend ?? '?'} load ${row.loadMs ?? '?'} ms${row.error ? ` ! ${row.error}` : ''}`);
        save();
      }
    }
  } finally {
    await browsers.chromium.close();
    await browsers.webkit.close();
  }
  save();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  if (typeof options.base !== 'string') throw new Error('needs --base <url>');
  const base = options.base;
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p74');
  mkdirSync(out, { recursive: true });
  if (options._[0] === 'ai') await runAi(base, out);
  else if (options._[0] === 'phones') await runPhones(base, out, options);
  else throw new Error('usage: p74-live.mjs ai|phones --base <url> --out <dir>');
}
