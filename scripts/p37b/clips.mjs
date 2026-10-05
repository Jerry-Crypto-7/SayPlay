/**
 * Klipy před/po pro P37B (T1, T9): 3 s hraní každé věty na desktopu 1280×720
 * a na Pixel 7, k tomu FPS telefonu se 4× zpomaleným CPU.
 *
 *   node scripts/p37b/clips.mjs --base http://127.0.0.1:3372 --out D:/caches/p37b/before \
 *     --set evals/play/p32/sentences.json --set evals/play/p37b/verbs.json [--only cat,chef] \
 *     [--seconds 3] [--fps-seconds 12] [--no-fps | --fps-only]
 *
 * Pro každou větu:
 * 1. Hra vznikne jako u hráče (`/play`, věta, „Play it“). Položka sady s `heroAction`
 *    (`verbs.json`) se znovu publikuje se specem doplněným o tu akci
 *    (`POST /api/play/games {spec}`), dokud ji neplní věta sama (P37A).
 * 2. Desktop a Pixel 7 (bez zpomalení – klip je o vzhledu): studené otevření
 *    odkazu, snímek prvního kreslení, pak `--seconds` hraní pevným vzorem kláves
 *    a ťuků. Hraje „člověk“, ne ukázka robota – ukázka sběrnici efektů ani
 *    zvuky nespouští. Vzor je pro před i po stejný, hra je deterministická.
 *    Během okna se počítají zvuky (každé `start()` zdroje Web Audio kromě
 *    smyčky hudby), efekty sběrnice (`window.__playFx`) a hudba (`window.__playAudio`).
 *    Video Playwrightu se ořízne ffmpegem na okno hraní a složí do archu 4×2
 *    snímků pro slepého soudce.
 * 3. FPS: Pixel 7, CPU 4×, bez nahrávání, robot hraje ukázku (jako `scripts/p32/shots.mjs`).
 *    Pouštět samostatně přes `node scripts/p32/heavy.mjs -- …`, jinak číslo neplatí.
 *    Ke každé sekundě i úroveň kvality a volání/trojúhelníky/sítě sondy `__playRender`
 *    (`fpsDetail`). `--fps-only` vynechá klipy (měření výkonu, T7).
 * 4. `--ghost` (T8): ukázka robota ducha schová, a tak FPS měří běh hráče, za kterého
 *    v reálném čase hraje robot (`__playShell.byHand`) – nejdřív bez ducha, pak se
 *    závodem s výzvou, kterou hra získá výhrou „rukou“ (`?dare=`). Výsledek `ghost`.
 *
 * Výstup: `<out>/result.json`, `<out>/<id>-{desktop,phone}.{webm,png}`,
 * `<out>/<id>-{desktop,phone}-first.png` a `<out>/first-frames.png` (prvních snímků všech her).
 * Exit 1, když některá věta skončila chybou.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, devices } from '@playwright/test';

export const USAGE =
  'usage: node scripts/p37b/clips.mjs --base <url> --out <dir> --set <sentences.json> [--set …] [--only id,id] [--seconds 3] [--fps-seconds 12] [--no-fps | --fps-only] [--ghost]';

const CPU_THROTTLING = 4;
const GAME_PATH = /^\/play\/[0-9a-f]+$/;
const DESKTOP = { viewport: { width: 1280, height: 720 } };
const PHONE = devices['Pixel 7'];

export function parseArgs(argv) {
  const options = { base: null, out: null, sets: [], only: null, seconds: 3, fpsSeconds: 12, fps: true, clips: true, ghost: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      return next;
    };
    if (flag === '--base') options.base = value().replace(/\/+$/, '');
    else if (flag === '--out') options.out = value();
    else if (flag === '--set') options.sets.push(value());
    else if (flag === '--only') options.only = value().split(',');
    else if (flag === '--no-fps') options.fps = false;
    else if (flag === '--fps-only') options.clips = false;
    else if (flag === '--ghost') options.ghost = true;
    else if (flag === '--seconds' || flag === '--fps-seconds') {
      const number = Number(value());
      if (!(number > 0)) throw new Error(`${flag} needs a positive number\n${USAGE}`);
      options[flag === '--seconds' ? 'seconds' : 'fpsSeconds'] = number;
    } else throw new Error(`unknown flag ${flag}\n${USAGE}`);
  }
  if (options.base === null || options.out === null || options.sets.length === 0) throw new Error(`missing --base, --out or --set\n${USAGE}`);
  return options;
}

/** Věty ze sad: `sentences` i `sealed` (přejímka P32 je má odděleně), id musí být v rámci běhu jedinečné. */
export function loadSets(files, only = null) {
  const out = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    for (const entry of [...(raw.sentences ?? []), ...(raw.sealed ?? [])]) {
      if (typeof entry.id !== 'string' || typeof entry.text !== 'string') throw new Error(`${file}: every sentence needs id and text`);
      if (out.some((known) => known.id === entry.id)) throw new Error(`${file}: duplicate id ${entry.id}`);
      out.push({ id: entry.id, text: entry.text, heroAction: entry.heroAction ?? null, set: file });
    }
  }
  return only === null ? out : out.filter((entry) => only.includes(entry.id));
}

/**
 * Před každým dokumentem: první kreslení na plátně hry a každý spuštěný zvuk.
 * Smyčka (`loop = true`) je hudba, zbytek jednorázové zvuky událostí a akcí.
 */
function instrument() {
  window.__p37b = { firstDraw: null, sounds: [] };
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function draw(...args) {
        if (window.__p37b.firstDraw === null && this.canvas instanceof HTMLCanvasElement && this.canvas.closest('[data-testid="arcade-stage"]') !== null) {
          window.__p37b.firstDraw = performance.now();
        }
        return original.apply(this, args);
      };
    }
  }
  for (const Node of [window.AudioBufferSourceNode, window.OscillatorNode]) {
    if (Node === undefined) continue;
    const start = Node.prototype.start;
    Node.prototype.start = function started(...args) {
      window.__p37b.sounds.push({ at: performance.now(), loop: this.loop === true });
      return start.apply(this, args);
    };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickIfVisible(page, testId) {
  const target = page.getByTestId(testId);
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click({ timeout: 1000 }).catch(() => {});
  return true;
}

/** Hra z věty cestou hráče; vrací cestu `/play/<id>`. */
async function createGame(browser, base, text) {
  const context = await browser.newContext(DESKTOP);
  try {
    const page = await context.newPage();
    await page.goto(`${base}/play`, { waitUntil: 'load' });
    await page.getByTestId('play-sentence').fill(text);
    await page.getByTestId('play-create').click();
    await page.waitForURL((url) => GAME_PATH.test(url.pathname), { timeout: 60_000 });
    return new URL(page.url()).pathname;
  } finally {
    await context.close();
  }
}

/** Tatáž hra s `heroAction` ve specu, publikovaná dveřmi pro hotový spec. */
async function withHeroAction(base, gamePath, heroAction) {
  const game = await (await fetch(`${base}/api${gamePath.replace('/play/', '/play/games/')}`)).json();
  if (game?.spec === undefined) throw new Error(`GET ${gamePath}: no spec`);
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: { ...game.spec, heroAction } }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.url !== 'string') throw new Error(`POST {spec} → ${String(response.status)} ${JSON.stringify(body)}`);
  return new URL(body.url, base).pathname;
}

/**
 * Pevný vzor hráče: úhyb vpravo a vlevo, skok, útok, použít, plyn, ťuk do scény.
 * Každé ovládání si z něj vezme, čemu rozumí; jeden krok ~250 ms.
 */
async function playPattern(page, seconds) {
  const stage = page.locator('[data-testid="arcade-stage"]').first();
  const box = await stage.boundingBox().catch(() => null);
  const hold = async (key, ms) => {
    await page.keyboard.down(key);
    await sleep(ms);
    await page.keyboard.up(key);
  };
  const steps = [
    () => hold('ArrowRight', 220),
    () => page.keyboard.press(' '),
    () => page.keyboard.press('j'),
    () => hold('ArrowUp', 220),
    () => (box === null ? page.keyboard.press(' ') : page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.55)),
    () => hold('ArrowLeft', 220),
    () => page.keyboard.press('k'),
    () => page.keyboard.press(' '),
  ];
  const end = Date.now() + seconds * 1000;
  for (let step = 0; Date.now() < end; step += 1) {
    if (await clickIfVisible(page, 'play-resume')) continue;
    const started = Date.now();
    await steps[step % steps.length]().catch(() => {});
    await sleep(Math.max(0, 250 - (Date.now() - started)));
  }
}

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${run.stderr}`);
}

/** Studené otevření, první snímek, `seconds` hraní, ořízlý klip a arch snímků. */
async function recordClip(browser, options, gamePath, id, device, name) {
  const raw = join(options.out, 'raw', `${id}-${name}`);
  mkdirSync(raw, { recursive: true });
  const size = device.viewport;
  const context = await browser.newContext({ ...device, recordVideo: { dir: raw, size } });
  await context.addInitScript(instrument);
  const out = { clip: null, sheet: null, zoom: null, first: null, firstDrawMs: null, control: null, look: null, hero: null, sounds: 0, music: null, musicLoops: 0, fx: {}, error: null };
  let video = null;
  try {
    const page = await context.newPage();
    video = page.video();
    const opened = Date.now();
    await page.goto(`${options.base}${gamePath}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__p37b?.firstDraw !== null, null, { timeout: 60_000 });
    out.firstDrawMs = Math.round(await page.evaluate(() => window.__p37b.firstDraw));
    const first = `${id}-${name}-first.png`;
    await page.screenshot({ path: join(options.out, first) });
    out.first = first;
    const stage = page.locator('[data-testid="arcade-stage"]').first();
    out.control = await stage.getAttribute('data-control').catch(() => null);
    out.look = await stage.getAttribute('data-look').catch(() => null);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)).catch(() => {});
    const fxBefore = await page.evaluate(() => window.__playFx?.() ?? {});
    const from = await page.evaluate(() => performance.now());
    const clipAt = (Date.now() - opened) / 1000;
    await playPattern(page, options.seconds);
    const after = await page.evaluate((since) => {
      // Hrdina v pixelech stránky ze sondy záběru (NDC → obdélník plátna scény).
      const box = window.__playFrame?.()?.hero ?? null;
      const rect = document.querySelector('[data-testid="arcade-stage"] canvas')?.getBoundingClientRect() ?? null;
      const hero =
        box === null || rect === null
          ? null
          : { cx: Math.round(rect.x + ((box.x + 1) / 2) * rect.width), cy: Math.round(rect.y + ((1 - box.y) / 2) * rect.height), px: Math.round(((box.maxY - box.minY) / 2) * rect.height) };
      return { sounds: window.__p37b.sounds.filter((sound) => sound.at >= since), music: window.__playAudio?.music?.() ?? null, fx: window.__playFx?.() ?? {}, hero };
    }, from);
    out.hero = after.hero;
    out.sounds = after.sounds.filter((sound) => !sound.loop).length;
    out.musicLoops = after.sounds.filter((sound) => sound.loop).length;
    out.music = after.music;
    for (const [kind, count] of Object.entries(after.fx)) {
      const delta = count - (fxBefore[kind] ?? 0);
      if (delta > 0) out.fx[kind] = delta;
    }
    await page.close();
    const source = await video.path();
    out.clip = `${id}-${name}.webm`;
    out.sheet = `${id}-${name}.png`;
    const window_ = ['-ss', clipAt.toFixed(2), '-t', String(options.seconds), '-i', source];
    ffmpeg([...window_, '-c:v', 'libvpx-vp9', '-b:v', '1M', join(options.out, out.clip)]);
    const width = name === 'desktop' ? 480 : 200;
    ffmpeg([...window_, '-vf', `fps=${(8 / options.seconds).toFixed(3)},scale=${String(width)}:-1,tile=4x2`, '-frames:v', '1', join(options.out, out.sheet)]);
    // Výřez kolem hrdiny (poloha z konce okna), 4 snímky – pro kontrolu činnosti hrdiny, ne pro soudce.
    if (out.hero !== null) {
      const cropW = Math.min(size.width, 360);
      const cropH = Math.min(size.height, 240);
      const left = Math.max(0, Math.min(size.width - cropW, out.hero.cx - cropW / 2));
      const top = Math.max(0, Math.min(size.height - cropH, out.hero.cy - cropH / 2));
      out.zoom = `${id}-${name}-hero.png`;
      ffmpeg([...window_, '-vf', `crop=${String(cropW)}:${String(cropH)}:${String(Math.round(left))}:${String(Math.round(top))},fps=${(4 / options.seconds).toFixed(3)},tile=4x1`, '-frames:v', '1', join(options.out, out.zoom)]);
    }
  } catch (error) {
    out.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  } finally {
    await context.close();
  }
  return out;
}

let darers = 0;

/**
 * Hra vyhraná „rukou“ (záznam robota cestou klávesnice) – server uloží běh výzvy pro ducha; vrací id výzvy.
 * Každá výzva z vlastní adresy: duchů je nejvýš 10 denně na volajícího (`GHOST_DAILY_CAP_PER_CALLER`).
 */
async function postDare(browser, base, gamePath) {
  darers += 1;
  const context = await browser.newContext({ ...DESKTOP, extraHTTPHeaders: { 'x-forwarded-for': `198.18.${String(Math.floor(darers / 250))}.${String((darers % 250) + 1)}` } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}${gamePath}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__playShell !== undefined, null, { timeout: 60_000 });
    const posted = page.waitForResponse((response) => response.url().endsWith('/dare') && response.request().method() === 'POST', { timeout: 60_000 });
    const end = await page.evaluate(() => window.__playShell.handPlay('end'));
    if (end.runState !== 'won') throw new Error(`hand play ended ${end.runState}, no dare`);
    const response = await posted;
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.dareId !== 'string') throw new Error(`POST dare → ${String(response.status)} ${JSON.stringify(body)}`);
    return body.dareId;
  } finally {
    await context.close();
  }
}

/**
 * Robot ověřovače hraje za hráče v reálném čase (60 tiků/s, nejvýš 4 za snímek):
 * běh je hráčův, ne ukázka, takže duch zůstane vidět. Konec běhu smyčku zastaví.
 */
function botAsHuman() {
  const shell = window.__playShell;
  shell.byHand(true);
  let last = performance.now();
  let due = 0;
  const frame = (now) => {
    due = Math.min(due + ((now - last) * 60) / 1000, 4);
    last = now;
    for (; due >= 1; due -= 1) {
      const wants = shell.botWants();
      if (wants === null) return;
      shell.hold(wants.axis);
      shell.press(wants.buttons);
      if (shell.tickByHand().runState !== 'running') return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Medián FPS na telefonu se zpomaleným CPU. Výchozí: robot hraje ukázku po celou dobu.
 * `human` = robot za hráče (`botAsHuman`), `dare` = odkaz výzvy, tedy závod s duchem.
 */
async function phoneFps(browser, options, gamePath, { human = false, dare = null } = {}) {
  const context = await browser.newContext(PHONE);
  await context.addInitScript(instrument);
  try {
    const page = await context.newPage();
    await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING });
    await page.goto(`${options.base}${gamePath}${dare === null ? '' : `?dare=${dare}`}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__p37b?.firstDraw !== null, null, { timeout: 90_000 });
    if (dare !== null) await page.waitForFunction(() => window.__playGhost !== undefined, null, { timeout: 30_000 });
    await sleep(1500);
    if (human) await page.evaluate(botAsHuman);
    const sampling = page.evaluate(
      (span) =>
        new Promise((resolve) => {
          const samples = [];
          // Ke každé sekundě úroveň kvality a co se kreslí (T7): kde se čas ztrácí.
          const detail = [];
          let frames = 0;
          let from = performance.now();
          const end = from + span * 1000;
          const frame = (now) => {
            frames += 1;
            if (now - from >= 1000) {
              samples.push(Math.round(((frames * 1000) / (now - from)) * 10) / 10);
              const render = window.__playRender?.();
              detail.push({
                tier: document.querySelector('[data-testid="arcade-stage"]')?.dataset.quality ?? null,
                calls: render?.calls ?? null,
                triangles: render?.triangles ?? null,
                meshes: render?.meshes ?? null,
                // Běh hráče (T8): tik a jestli duch byl v té sekundě vidět.
                tick: window.__playShell?.tick?.() ?? null,
                ghost: window.__playGhost?.().shown ?? null,
              });
              frames = 0;
              from = now;
            }
            if (now < end) requestAnimationFrame(frame);
            else resolve({ samples, detail });
          };
          requestAnimationFrame(frame);
        }),
      options.fpsSeconds,
    );
    const end = Date.now() + options.fpsSeconds * 1000;
    while (!human && Date.now() < end) {
      if (!(await clickIfVisible(page, 'play-demo-start'))) if (!(await clickIfVisible(page, 'play-demo-yours'))) await clickIfVisible(page, 'play-again');
      await sleep(500);
    }
    const { samples, detail } = await sampling;
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return { median, samples, detail };
  } finally {
    await context.close();
  }
}

export async function clips(options, { log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const sentences = loadSets(options.sets, options.only);
  mkdirSync(options.out, { recursive: true });
  // Stejný renderer jako e2e na Windows (`scripts/browser-renderer.ts`): skutečná GPU přes ANGLE/D3D11.
  const browser = await chromium.launch({ args: process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11'] : [] });
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    for (const sentence of sentences) {
      const entry = { id: sentence.id, text: sentence.text, heroAction: sentence.heroAction, gamePath: null, desktop: null, phone: null, fpsMedian: null, fpsSamples: [], error: null };
      try {
        entry.gamePath = await createGame(browser, options.base, sentence.text);
        if (sentence.heroAction !== null) entry.gamePath = await withHeroAction(options.base, entry.gamePath, sentence.heroAction);
        if (options.clips) {
          entry.desktop = await recordClip(browser, options, entry.gamePath, sentence.id, DESKTOP, 'desktop');
          entry.phone = await recordClip(browser, options, entry.gamePath, sentence.id, PHONE, 'phone');
        }
        if (options.fps && options.ghost) {
          // Bez ducha dřív, než výzva existuje – jinak by hra bez odkazu závodila s nejlepším během.
          const without = await phoneFps(browser, options, entry.gamePath, { human: true });
          const dare = await postDare(browser, options.base, entry.gamePath);
          entry.ghost = { dare, without, with: await phoneFps(browser, options, entry.gamePath, { human: true, dare }) };
          entry.fpsMedian = entry.ghost.with.median;
          entry.fpsSamples = entry.ghost.with.samples;
          entry.fpsDetail = entry.ghost.with.detail;
        } else if (options.fps) {
          const fps = await phoneFps(browser, options, entry.gamePath);
          entry.fpsMedian = fps.median;
          entry.fpsSamples = fps.samples;
          entry.fpsDetail = fps.detail;
        }
        const errors = [entry.desktop?.error && `desktop: ${entry.desktop.error}`, entry.phone?.error && `phone: ${entry.phone.error}`].filter(Boolean);
        entry.error = errors.length === 0 ? null : errors.join('; ');
      } catch (error) {
        entry.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
      }
      results.push(entry);
      const d = entry.desktop;
      const tiers = (entry.fpsDetail ?? []).map((second) => second.tier?.[0] ?? '?').join('');
      log(`[p37b-clips] ${sentence.id}: ${d?.control ?? '–'}/${d?.look ?? '–'}, sounds ${String(d?.sounds ?? '–')}, fx ${JSON.stringify(d?.fx ?? {})}, music ${d?.music ? 'on' : 'off'}, hero ${String(d?.hero?.px ?? '–')} px, fps ${String(entry.fpsMedian ?? '–')} ${JSON.stringify(entry.fpsSamples)} tiers ${tiers}${entry.ghost ? `, ghost ${String(entry.ghost.without.median)} → ${String(entry.ghost.with.median)} (shown ${String(entry.ghost.with.detail.filter((second) => second.ghost === true).length)}/${String(entry.ghost.with.detail.length)} s)` : ''}${entry.error ? ` – ERROR ${entry.error}` : ''}`);
    }
  } finally {
    await browser.close();
  }
  const firsts = results.flatMap((entry) => (entry.desktop?.first ? [join(options.out, entry.desktop.first)] : []));
  if (firsts.length > 0) {
    // Mřížka po šesti: desktop 1280×720 zmenšený na 320×180.
    const columns = Math.min(6, firsts.length);
    ffmpeg([...firsts.flatMap((file) => ['-i', file]), '-filter_complex', `${firsts.map((_, index) => `[${String(index)}:v]scale=320:-1[s${String(index)}]`).join(';')};${firsts.map((_, index) => `[s${String(index)}]`).join('')}xstack=inputs=${String(firsts.length)}:layout=${firsts.map((_, index) => `${String((index % columns) * 320)}_${String(Math.floor(index / columns) * 180)}`).join('|')}:fill=white`, '-frames:v', '1', join(options.out, 'first-frames.png')]);
  }
  rmSync(join(options.out, 'raw'), { recursive: true, force: true });
  const result = {
    schema: 'p37b-clips/1',
    base: options.base,
    sets: options.sets,
    startedAt,
    finishedAt: new Date().toISOString(),
    settings: { desktop: '1280x720', phone: 'Pixel 7', cpuThrottling: CPU_THROTTLING, seconds: options.seconds, fpsSeconds: options.fpsSeconds },
    sentences: results,
  };
  writeFileSync(join(options.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const result = await clips(options);
  process.exitCode = result.sentences.every((sentence) => sentence.error === null) ? 0 : 1;
}
