#!/usr/bin/env node
/**
 * Rozpočet snímku ve VR (P65 T6): všech 19 žánrů v emulátoru IWER (Quest 2, dvě oči), na produkčním buildu.
 * Každý žánr se publikuje z živé buňky (`liveCells`, jako e2e `vr-native` a `vr-diorama`), stránka s `?vr=1`
 * vstoupí do VR a robot ověřovače (`botWants`) hraje s ručními hodinami (`byHand`) až `TICKS` tiků. Každých
 * `EVERY` tiků se zapíše jeden snímek: draw cally a trojúhelníky z `renderer.info` (sonda `__playRender`, obě oči
 * dohromady), počet textur a paměť textur a render bufferů na GPU (obal volání WebGL, sčítá skutečné alokace).
 *
 * Panely nad hrou (P67 T13): po hře robot dohraje do konce (`handPlay`) a zapíše se snímek s panelem výsledku,
 * s kartou sdílení s QR kódem a s panelem „Comfort“ (vzorky s `panel`). Obrazovky bez žánru (`screens`): VR lobby
 * na `/play` (karta a 3D klávesnice) a feed ve VR (kolo karty, výsledek s „Next“, náhled další karty).
 *
 * Čísla jsou deterministická: stejný build, stejná hra a týž robot dají tatáž čísla, proto v souboru není čas.
 * Náhled robota ve feedu a v lobby běží na hodinách stránky, tam se čísla mezi běhy smí lišit o pár volání.
 * FPS emulátor neměří – GPU je tohoto stroje, ne Questu; FPS z brýlí dává `scripts/quest-dev.mjs --tour`.
 *
 *   npm run build
 *   PLAY_STORE_DIR=D:/caches/p67/store node node_modules/next/dist/bin/next start -p 3168
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/vr/budget.mjs [--base http://127.0.0.1:3168] [--out evals/vr/budget.json] [--genres runner.default,lobby]
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/vr/budget.mjs --base http://127.0.0.1:3168 --publish
 *
 * `--genres` změří jen vyjmenované žánry a obrazovky (`lobby`, `feed`); ostatní zůstanou v souboru z minulého
 * měření (P67 T6). `--publish` jen publikuje hru každého žánru a vypíše JSON `[{ id, kind, url }]` – prohlídka
 * žánrů v brýlích (`quest-dev.mjs --tour`) tak hraje tytéž hry jako rozpočet. `--table` jen vypíše řádky tabulek
 * README ze souboru `--out`, nic neměří.
 * Jeden prohlížeč naráz proti jednomu serveru: dva souběžné procesy `next start` zaseknou.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { STAGE, TABLE } from '@/play/xr/diorama-scale';
import { QUEST2_BUDGET, XR_QUALITY } from '@/play/xr/quality';

import { browserRenderer } from '../../scripts/browser-renderer.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IWER_BUNDLE = join(ROOT, 'node_modules/iwer/build/iwer.min.js');

/**
 * Rozdělení žánrů jako v e2e: čtyři VR-nativní (`vr-native.spec.ts`), tři kolem hráče (`vr-room.spec.ts`, P67 T6),
 * šest tratí na pódiu (`surround`, P67 T7) a šest dioram na stole (obojí `vr-diorama.spec.ts`).
 */
export const NATIVE = ['shooter.default', 'throw.default', 'whack.default', 'slice.default'];
export const ROOM = ['arena.escape', 'catch.default', 'defense.default'];
export const SURROUND = ['runner.default', 'platformer.default', 'flap.default', 'voyage.race', 'hop.default', 'crowd.default'];
export const DIORAMA = ['timing.stack', 'rhythm.default', 'duel.default', 'quest.spatial', 'merge.default', 'push.default'];
/** Obrazovky bez žánru (P67 T13). */
export const SCREENS = ['lobby', 'feed'];

const kindOf = (id) => (NATIVE.includes(id) ? 'native' : ROOM.includes(id) ? 'room' : SURROUND.includes(id) ? 'surround' : 'diorama');

/** 10 s hry; snímek každou půlsekundu. */
const TICKS = 600;
const EVERY = 30;
/** Snímky obrazovky bez tiků hry (lobby, náhled feedu): `STILLS` vzorků po `EVERY` snímcích stránky. */
const STILLS = 10;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const base = arg('base', 'http://127.0.0.1:3168');
const out = resolve(ROOT, arg('out', 'evals/vr/budget.json'));
const only = arg('genres', null)?.split(',');

/** Sklon hlavy dolů na střed desky, nebo pódia tratí (rad), jako `vr-diorama.spec.ts`. */
const PITCH = { diorama: Math.atan2(1.6 - TABLE.top, -TABLE.z), surround: Math.atan2(1.6 - STAGE.top, -STAGE.z) };
/** Pohled dolů na lobby a feed (rad), jako `vr-lobby.spec.ts` a `vr-feed.spec.ts`. */
const SCREEN_PITCH = (19 * Math.PI) / 180;
/** Pravá ruka před tělem, odkud paprsek míří na tlačítka panelů (jako e2e `vr-hud`, `vr-lobby`, `vr-feed`). */
const HAND = [0.2, 1.2, -0.25];
/** Hry feedu z fixtur jako `vr-feed.spec.ts`: tytéž karty za lobby i ve feedu, bez ohledu na obsah úložiště. */
const FEED_FIXTURES = [
  ['runner.json', 'VR budget runner through the canyon'],
  ['flap.json', 'VR budget flap between the pipes'],
  ['platform.json', 'VR budget platform over the rooftops'],
];

/**
 * Paměť textur na GPU: init skript obalí volání WebGL2, která alokují (`texImage*`, `texStorage*`,
 * `compressedTexImage*`, `renderbufferStorage*`, `generateMipmap`) a uvolňují (`delete*`), a drží velikost každého
 * objektu. `renderer.info` umí jen počet textur, ne bajty, a nevidí render buffery skládače.
 */
function textureMeter() {
  const proto = WebGL2RenderingContext.prototype;
  /** Objekt GPU → bajty po částech (úroveň mipmapy, stěna krychle, úložiště). */
  const sizes = new Map();
  const state = new WeakMap();
  const of = (gl) => {
    let found = state.get(gl);
    if (found === undefined) {
      found = { unit: 0x84c0, bound: new Map(), renderbuffer: null };
      state.set(gl, found);
    }
    return found;
  };
  // Bajty na pixel podle vnitřního formátu (WebGL2 sized formats); neznámý = 4.
  const PER_PIXEL = new Map([
    [0x8058, 4], [0x8c43, 4], [0x881a, 8], [0x8814, 16], [0x8229, 1], [0x822b, 2], [0x822d, 2], [0x822f, 4], [0x822e, 4],
    [0x8230, 8], [0x8051, 3], [0x881b, 6], [0x8815, 12], [0x88f0, 4], [0x81a6, 4], [0x8cac, 4], [0x81a5, 2], [0x8cad, 8],
    [0x8d48, 1], [0x1906, 1], [0x1909, 1], [0x190a, 2], [0x8c3a, 4], [0x8059, 4], [0x8d62, 2], [0x8056, 2], [0x8057, 2],
  ]);
  const perPixel = (internal, type) => {
    if (internal === 0x1908 || internal === 0x1907) return (internal === 0x1908 ? 4 : 3) * (type === 0x1406 ? 4 : type === 0x140b || type === 0x8d61 ? 2 : 1);
    return PER_PIXEL.get(internal) ?? 4;
  };
  const CUBE = 0x8513;
  const ownerTarget = (target) => (target >= 0x8515 && target <= 0x851a ? CUBE : target);
  const boundTo = (gl, target) => of(gl).bound.get(`${of(gl).unit}:${ownerTarget(target)}`) ?? null;
  const put = (object, part, bytes) => {
    if (object === null || object === undefined) return;
    let parts = sizes.get(object);
    if (parts === undefined) {
      parts = new Map();
      sizes.set(object, parts);
    }
    parts.set(part, bytes);
  };
  const dims = (source) => [source.videoWidth || source.naturalWidth || source.displayWidth || source.codedWidth || source.width || 0, source.videoHeight || source.naturalHeight || source.displayHeight || source.codedHeight || source.height || 0];
  const wrap = (name, record) => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function (...args) {
      const result = original.apply(this, args);
      try {
        record(this, args, result);
      } catch {
        // Měřák nesmí shodit hru.
      }
      return result;
    };
  };
  wrap('activeTexture', (gl, [unit]) => {
    of(gl).unit = unit;
  });
  wrap('bindTexture', (gl, [target, texture]) => {
    of(gl).bound.set(`${of(gl).unit}:${target}`, texture);
  });
  wrap('texImage2D', (gl, args) => {
    const [target, level, internal] = args;
    const [width, height, type] = args.length >= 8 && typeof args[3] === 'number' ? [args[3], args[4], args[7]] : [...dims(args[5]), args[4]];
    put(boundTo(gl, target), `${target}:${level}`, width * height * perPixel(internal, type));
  });
  wrap('texImage3D', (gl, [target, level, internal, width, height, depth, , , type]) => {
    put(boundTo(gl, target), `${target}:${level}`, width * height * depth * perPixel(internal, type));
  });
  wrap('texStorage2D', (gl, [target, levels, internal, width, height]) => {
    let bytes = 0;
    for (let level = 0; level < levels; level += 1) bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * perPixel(internal);
    put(boundTo(gl, target), 'storage', bytes * (target === CUBE ? 6 : 1));
  });
  wrap('texStorage3D', (gl, [target, levels, internal, width, height, depth]) => {
    let bytes = 0;
    for (let level = 0; level < levels; level += 1) bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * depth * perPixel(internal);
    put(boundTo(gl, target), 'storage', bytes);
  });
  wrap('compressedTexImage2D', (gl, args) => {
    const [target, level] = args;
    const data = args[6];
    put(boundTo(gl, target), `${target}:${level}`, typeof data === 'number' ? data : (data?.byteLength ?? 0));
  });
  wrap('compressedTexImage3D', (gl, args) => {
    const [target, level] = args;
    const data = args[7];
    put(boundTo(gl, target), `${target}:${level}`, typeof data === 'number' ? data : (data?.byteLength ?? 0));
  });
  wrap('generateMipmap', (gl, [target]) => {
    const texture = boundTo(gl, target);
    const parts = sizes.get(texture);
    if (parts === undefined) return;
    let base = 0;
    for (const [part, bytes] of parts) if (part.endsWith(':0')) base += bytes;
    put(texture, 'mips', base / 3);
  });
  wrap('deleteTexture', (_gl, [texture]) => {
    sizes.delete(texture);
  });
  wrap('bindRenderbuffer', (gl, [, renderbuffer]) => {
    of(gl).renderbuffer = renderbuffer;
  });
  wrap('renderbufferStorage', (gl, [, internal, width, height]) => {
    put(of(gl).renderbuffer, 'storage', width * height * perPixel(internal));
  });
  wrap('renderbufferStorageMultisample', (gl, [, samples, internal, width, height]) => {
    put(of(gl).renderbuffer, 'storage', width * height * perPixel(internal) * Math.max(1, samples));
  });
  wrap('deleteRenderbuffer', (_gl, [renderbuffer]) => {
    sizes.delete(renderbuffer);
  });
  window.__gpuBytes = () => {
    let textures = 0;
    let renderbuffers = 0;
    for (const [object, parts] of sizes) {
      let bytes = 0;
      for (const part of parts.values()) bytes += part;
      if (object instanceof WebGLRenderbuffer) renderbuffers += bytes;
      else textures += bytes;
    }
    return { textures, renderbuffers };
  };
  /**
   * Jeden vzorek posledního snímku VR. `xrCalls` jsou volání plátna relace (`__playXr`): kdyby sonda `__playRender`
   * patřila jinému plátnu (karta feedu mimo relaci), rozejdou se a běh to ohlásí.
   */
  window.__budgetSample = (tick, panel) => {
    const render = window.__playRender();
    const xr = window.__playXr();
    const gpu = window.__gpuBytes();
    return {
      tick,
      panel,
      calls: render.calls,
      xrCalls: xr.calls,
      triangles: render.triangles,
      textures: render.textures,
      textureMB: gpu.textures / (1024 * 1024),
      renderbufferMB: gpu.renderbuffers / (1024 * 1024),
      presenting: xr.presenting,
      eyes: xr.eyes,
      quality: document.querySelector('[data-quality]')?.getAttribute('data-quality') ?? null,
    };
  };
}

/** Quest 2 v IWER. `leftDown`: paprsek levé ruky k zemi, ať v lobby a feedu neleží na spodní řadě tlačítek. */
function withQuest2({ pitch, leftDown }) {
  const device = new window.IWER.XRDevice(window.IWER.metaQuest2);
  device.stereoEnabled = true;
  device.installRuntime({ forceInstall: true });
  device.position.set(0, 1.6, 0);
  device.quaternion.set(-Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
  // Paprsek pravého ovladače svisle nahoru: na stůl ani na pruhy nemíří, hraje robot.
  device.controllers.right?.position.set(0.25, 1.2, -0.25);
  device.controllers.right?.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  device.controllers.left?.position.set(-0.3, 1.1, -0.4);
  if (leftDown) device.controllers.left?.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  else device.controllers.left?.quaternion.set(0, 0, 0, 1);
  window.__quest = device;
}

/** MB na jedno desetinné místo. */
const tenth = (value) => Math.round(value * 10) / 10;

async function post(body) {
  const response = await fetch(new URL('/api/play/games', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`publish ${String(response.status)} ${await response.text()}`);
  return /** @type {{ url: string, versionId: string, archetype: string }} */ (await response.json());
}

async function publish(id) {
  const cell = liveCells().find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`${id} is not a live cell`);
  return (await post({ spec: compileRecipe(assemblyOfCell(cell)) })).url;
}

/** Řádky feedu (`/api/play/games?recent=`) z her fixtur; podvrhují se stránce jako ve `vr-feed.spec.ts`. */
async function feedRows() {
  const rows = [];
  for (const [index, [fixture, title]] of FEED_FIXTURES.entries()) {
    const spec = JSON.parse(readFileSync(join(ROOT, 'src/play/arcade/__fixtures__', fixture), 'utf8'));
    const body = await post({ spec: { ...spec, title } });
    rows.push({ versionId: body.versionId, title, archetype: body.archetype, createdAt: new Date(Date.UTC(2026, 9, 29) - index * 1000).toISOString(), parentId: null, remixes: 0 });
  }
  return rows;
}

/**
 * Scéna dostavěná: počet geometrií a textur se 1,5 s nezměnil (modely se dotahují po síti). Scéna, která si
 * geometrii staví průběžně, se nemusí ustálit nikdy – po 20 s se měří i tak a soubor to přizná (`settled`).
 */
async function settled(page) {
  let last = '';
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => {
      const render = window.__playRender?.();
      return render === undefined ? '' : `${String(render.geometries)}:${String(render.textures)}`;
    });
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (now !== '' && Date.now() - since >= 1500) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/** Nová stránka s Questem 2, měřákem a sběrem chyb (i snímků VR: `KeepXrFrames` v `XrRoot` je hlásí jen do konzole). */
async function openPage(browser, quest, viewport = { width: 1280, height: 720 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  const note = (text) => {
    const line = text.split('\n')[0].slice(0, 200);
    if (!errors.includes(line)) errors.push(line);
  };
  page.on('pageerror', (error) => note(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') note(message.text());
  });
  await page.addInitScript(textureMeter);
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(withQuest2, quest);
  return { context, page, errors };
}

/** „Enter VR“ (`button`), dokud relace nezačne; emulátor ji občas napoprvé nezačne. */
async function enterVr(page, button, id, errors) {
  for (let attempt = 1; ; attempt += 1) {
    await button.click();
    const entered = await page.waitForFunction(() => window.__playXr?.().presenting === true, undefined, { timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    if (entered) return;
    if (attempt === 3) throw new Error(`${id}: no VR session after ${String(attempt)} clicks; page errors: ${errors.join(' | ') || 'none'}`);
  }
}

/** Robot hraje `ticks` tiků ručními hodinami; každých `every` tiků vzorek, na konci ještě jeden. */
function playByBot(page, ticks) {
  return page.evaluate(
    async ({ ticks, every }) => {
      const frames = (count) =>
        new Promise((done) => {
          const next = (left) => (left === 0 ? done() : requestAnimationFrame(() => next(left - 1)));
          next(count);
        });
      const shell = window.__playShell;
      const samples = [];
      let end = null;
      for (let tick = 0; tick < ticks && (end === null || end.runState === 'running'); tick += 1) {
        // Kolo feedu běží už před `byHand`: robot ještě nemá pozorování starší o svou reakci a prvních pár tiků nehraje.
        let want = null;
        try {
          want = shell.botWants();
        } catch {
          want = null;
        }
        shell.hold(want?.axis ?? 0);
        shell.press(want?.buttons ?? 0);
        end = shell.tickByHand();
        await frames(1);
        if ((tick + 1) % every === 0) {
          await frames(2);
          samples.push(window.__budgetSample(end.tick, null));
        }
      }
      await frames(3);
      samples.push(window.__budgetSample(end.tick, null));
      return { end, samples };
    },
    { ticks, every: EVERY },
  );
}

/** `STILLS` vzorků obrazovky po `EVERY` snímcích stránky, bez tiků hry; `panel` = co je otevřené. */
function stills(page, panel) {
  return page.evaluate(
    async ({ panel, count, every }) => {
      const frames = (left) => new Promise((done) => (left === 0 ? done() : requestAnimationFrame(() => frames(left - 1).then(done))));
      const samples = [];
      for (let at = 0; at < count; at += 1) {
        await frames(every);
        samples.push(window.__budgetSample(window.__playShell?.tick() ?? null, panel));
      }
      return samples;
    },
    { panel, count: STILLS, every: EVERY },
  );
}

/** Panel `id` ve scéně (do 20 s) a dva snímky na dokreslení; vrátí vzorek s ním, nebo chybu. */
async function panelSample(page, id, until = 'shown') {
  const sample = await page.evaluate(
    async ({ id, until }) => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
      const find = () => window.__playXr?.().panels.find((candidate) => candidate.id === id) ?? null;
      const deadline = performance.now() + 20_000;
      // Karta sdílení: s QR kódem, až je odkaz hotový (výzva se po odmítnutí stropem zkouší znovu po 3 s).
      while ((find() === null || (until === 'qr' && find().qr === null)) && performance.now() < deadline) await frame();
      if (find() === null) return null;
      for (let at = 0; at < 3; at += 1) await frame();
      return { ...window.__budgetSample(window.__playShell?.tick() ?? null, id), qr: find().qr !== null };
    },
    { id, until },
  );
  if (sample === null) throw new Error(`panel ${id} never showed`);
  return sample;
}

/**
 * Klik paprskem pravé ruky na tlačítko panelu: paprsek na střed tlačítka, spoušť dolů, až ho tlačítko ucítí,
 * a nahoru ve snímku, kdy hlásí stisk (klik = stisk a puštění na tlačítku, `XrRoot`). Paprsek se odvrátí až po
 * třech snímcích, ať puštění padne ještě na tlačítko.
 */
async function click(page, panel, button) {
  const failed = await page.evaluate(
    async ({ panel, button, from }) => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
      const find = () => window.__playXr?.().panels.find((candidate) => candidate.id === panel)?.buttons.find((candidate) => candidate.id === button) ?? null;
      const deadline = performance.now() + 20_000;
      while (find() === null && performance.now() < deadline) await frame();
      const target = find();
      if (target === null) return `${panel} has no ${button}`;
      const right = window.__quest.controllers.right;
      right.position.set(...from);
      const { at } = target;
      const length = Math.hypot(at.x - from[0], at.y - from[1], at.z - from[2]);
      const [x, y, z] = [(at.x - from[0]) / length, (at.y - from[1]) / length, (at.z - from[2]) / length];
      // Otočení, které dá −z (směr paprsku) na (x, y, z).
      const q = [y, -x, 0, 1 - z];
      const norm = Math.hypot(...q);
      right.quaternion.set(q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm);
      // Stav tlačítka ze snímku před namířením neplatí: dva snímky, než ho paprsek přepočítá.
      await frame();
      await frame();
      const reached = async (want) => {
        const until = performance.now() + 5_000;
        while (find()?.state !== want && performance.now() < until) await frame();
        return find()?.state === want;
      };
      if (!(await reached('aimed'))) return `${panel}:${button} never aimed`;
      right.updateButtonValue('trigger', 1);
      const pressed = await reached('pressed');
      right.updateButtonValue('trigger', 0);
      for (let at = 0; at < 3; at += 1) await frame();
      right.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      return pressed ? null : `${panel}:${button} never pressed`;
    },
    { panel, button, from: HAND },
  );
  if (failed !== null) throw new Error(failed);
}

/**
 * Panely nad dohranou hrou: výsledek, karta sdílení s QR kódem, „Comfort“ a lobby z „New game“ i s 3D klávesnicí
 * (`Type`) – lobby tak stojí i nad nejtěžší hrou, ne jen nad kartou feedu domova. Robot dohraje kolo do konce
 * (`handPlay`); hra, kterou ani tak neukončí, dohraje bez stisku (`idleRun`).
 */
async function overGame(page) {
  const end = await page.evaluate(() => {
    const shell = window.__playShell;
    const won = shell.handPlay('end');
    return won.runState === 'running' ? shell.idleRun() : won;
  });
  if (end.runState === 'running') return { end, samples: [] };
  // Levý paprsek k zemi: rovně dopředu leží u VR-nativních žánrů na tlačítku panelu a to pak hlásí paprsek dřív,
  // než na něj dojde pravý (spoušť by šla do prázdna).
  await page.evaluate(() => window.__quest.controllers.left?.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
  const result = await panelSample(page, 'result');
  await click(page, 'result', 'share');
  const share = await panelSample(page, 'share', 'qr');
  await click(page, 'share', 'done');
  await click(page, 'result', 'comfort');
  const comfort = await panelSample(page, 'comfort');
  await click(page, 'comfort', 'done');
  await click(page, 'result', 'new');
  const lobby = await panelSample(page, 'lobby');
  await click(page, 'lobby', 'type');
  const keyboard = await panelSample(page, 'keyboard');
  return { end, samples: [result, share, comfort, lobby, keyboard] };
}

async function measureGenre(browser, id) {
  const kind = kindOf(id);
  const url = await publish(id);
  // VR-nativní žánry a svět kolem hráče: hlava rovně jako v `vr-native.spec.ts` a `vr-room.spec.ts`; diorama a pódium: pohled na střed.
  const { context, page, errors } = await openPage(browser, { pitch: PITCH[kind] ?? 0, leftDown: false });
  await page.goto(new URL(`${url}?vr=1`, base).href);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await page.evaluate(() => window.__playShell.byHand(true));
  // Relaci jde začít, až plátno XR stojí (sonda `__playXr` žije uvnitř `<XR>`); klik před tím se ztratí.
  await page.waitForFunction(() => window.__playXr !== undefined && window.__playRender !== undefined, undefined, { timeout: 30_000 });
  await enterVr(page, page.getByTestId('enter-vr'), id, errors);
  const ready = await settled(page);
  const played = await playByBot(page, TICKS);
  const desk = await page.evaluate(() => window.__playXr().desk?.scale ?? null);
  const room = await page.evaluate(() => window.__playXr().room?.scale ?? null);
  const panels = await overGame(page);
  await context.close();
  return {
    id,
    kind,
    scale: desk === null ? (room === null ? null : `1:${(1 / room).toFixed(1)}`) : `1:${(1 / desk).toFixed(1)}`,
    settled: ready,
    end: { runState: played.end.runState, tick: played.end.tick, score: played.end.score },
    over: { runState: panels.end.runState, tick: panels.end.tick },
    errors,
    samples: [...played.samples, ...panels.samples],
  };
}

/** VR lobby na `/play` („Enter VR“ v liště domova): karta lobby, pak s 3D klávesnicí (`Type`). */
async function measureLobby(browser, rows) {
  const { context, page, errors } = await openPage(browser, { pitch: SCREEN_PITCH, leftDown: true });
  await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
  await page.goto(new URL('/play', base).href);
  const enter = page.locator('.play-appbar').getByTestId('enter-vr');
  await enter.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => window.__playXr !== undefined, undefined, { timeout: 30_000 });
  await enterVr(page, enter, 'lobby', errors);
  await page.waitForFunction(() => window.__playRender !== undefined, undefined, { timeout: 30_000 });
  const ready = await settled(page);
  await panelSample(page, 'lobby');
  const lobby = await stills(page, 'lobby');
  await click(page, 'lobby', 'type');
  await panelSample(page, 'keyboard');
  const keyboard = await stills(page, 'keyboard');
  await context.close();
  return { id: 'lobby', kind: 'screen', scale: null, settled: ready, errors, samples: [...lobby, ...keyboard] };
}

/**
 * Feed ve VR (`/play?g=`): kolo karty v relaci (robot), výsledek s „Next“ a náhled robota další karty po „Next“.
 * Do kola jako ve `vr-feed.spec.ts`: náhled převezme klávesa, „Enter VR“ je v HUD karty.
 */
async function measureFeed(browser, rows) {
  const { context, page, errors } = await openPage(browser, { pitch: SCREEN_PITCH, leftDown: true }, { width: 1440, height: 900 });
  await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
  await page.goto(new URL(`/play?g=${rows[0].versionId}`, base).href);
  await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
  const mode = (want, versionId) =>
    page.waitForFunction(({ want, versionId }) => window.__playFeed?.().mode === want && (versionId === null || window.__playFeed().versionId === versionId), { want, versionId }, { timeout: 30_000 });
  await mode('preview', rows[0].versionId);
  await page.keyboard.press('ArrowLeft');
  await mode('play', rows[0].versionId);
  await page.evaluate(() => window.__playShell.byHand(true));
  const enter = page.getByTestId('feed-current').getByTestId('enter-vr');
  await enter.waitFor({ timeout: 30_000 });
  await enterVr(page, enter, 'feed', errors);
  const ready = await settled(page);
  const played = await playByBot(page, TICKS);
  await page.evaluate(() => window.__playShell.handPlay('end'));
  await mode('result', rows[0].versionId);
  const result = await panelSample(page, 'result');
  await click(page, 'result', 'next');
  await mode('preview', rows[1].versionId);
  const next = await stills(page, null);
  await context.close();
  return { id: 'feed', kind: 'screen', scale: null, settled: ready, end: { runState: played.end.runState, tick: played.end.tick, score: played.end.score }, errors, samples: [...played.samples, result, ...next] };
}

/** Nejvyšší hodnota pole přes snímky – rozpočet platí pro nejhorší snímek. */
export const peak = (samples, field) => Math.max(...samples.map((sample) => sample[field]));

/** Nejhorší snímek s panelem `panel` (volání a trojúhelníky), `null` = panel se neměřil. */
const panelPeak = (samples, panel) => {
  const open = samples.filter((sample) => sample.panel === panel);
  return open.length === 0 ? null : { calls: peak(open, 'calls'), triangles: peak(open, 'triangles') };
};

/** Vzorky s MB na desetiny a souhrn nejhoršího snímku z nich (`budget.test.ts` ho spočte znovu). */
function summarize(row) {
  const samples = row.samples.map((sample) => ({ ...sample, textureMB: tenth(sample.textureMB), renderbufferMB: tenth(sample.renderbufferMB) }));
  return { ...row, samples, max: { calls: peak(samples, 'calls'), triangles: peak(samples, 'triangles'), textureMB: peak(samples, 'textureMB') } };
}

/** Jedno opakování: emulátor občas relaci nezačne; druhé selhání shodí běh, ať soubor nemá díru. */
async function once(id, measure) {
  const started = Date.now();
  const row = summarize(
    await measure().catch((error) => {
      console.log(`${id}: ${String(error).split('\n')[0]} – once more`);
      return measure();
    }),
  );
  const split = row.samples.filter((sample) => sample.calls !== sample.xrCalls);
  const panels = ['result', 'share', 'comfort', 'lobby', 'keyboard']
    .map((panel) => [panel, panelPeak(row.samples, panel)])
    .filter(([, at]) => at !== null)
    .map(([panel, at]) => `${panel} ${String(at.calls)}`);
  console.log(
    `${id.padEnd(20)} calls ${String(row.max.calls).padStart(4)}  triangles ${String(row.max.triangles).padStart(7)}  textures ${row.max.textureMB.toFixed(1)} MB  ${panels.join(', ')}  ${String(Math.round((Date.now() - started) / 1000))} s${split.length > 0 ? `  PROBE SPLIT: ${String(split.length)} samples` : ''}${row.errors.length > 0 ? `  errors: ${row.errors.join(' | ')}` : ''}`,
  );
  return row;
}

/** Hra každého žánru na serveru → `[{ id, kind, url }]` pro prohlídku v brýlích (`quest-dev.mjs --tour`). */
async function publishAll(ids) {
  const games = [];
  for (const id of ids) games.push({ id, kind: kindOf(id), url: await publish(id) });
  console.log(JSON.stringify(games));
}

async function main() {
  const order = [...NATIVE, ...ROOM, ...SURROUND, ...DIORAMA];
  const ids = order.filter((id) => only === undefined || only.includes(id));
  if (process.argv.includes('--publish')) {
    await publishAll(ids);
    return;
  }
  if (process.argv.includes('--table')) {
    printTable(JSON.parse(readFileSync(out, 'utf8')));
    return;
  }
  const screens = SCREENS.filter((id) => only === undefined || only.includes(id));
  // Bez OpenXR runtime počítače (SteamVR by hlásil immersive-vr i bez brýlí); brýle hraje IWER, jako v `playwright.config.ts`.
  const browser = await chromium.launch({ args: [...browserRenderer().args, '--disable-features=OpenXR'] });
  const genres = [];
  const shown = [];
  try {
    for (const id of ids) genres.push(await once(id, () => measureGenre(browser, id)));
    if (screens.length > 0) {
      const rows = await feedRows();
      if (screens.includes('lobby')) shown.push(await once('lobby', () => measureLobby(browser, rows)));
      if (screens.includes('feed')) shown.push(await once('feed', () => measureFeed(browser, rows)));
    }
  } finally {
    await browser.close();
  }
  // Zúžený běh: nezměřené žánry a obrazovky zůstanou z minulého měření, pořadí podle rozdělení.
  const previous = only === undefined || !existsSync(out) ? { genres: [], screens: [] } : JSON.parse(readFileSync(out, 'utf8'));
  const all = [...previous.genres.filter((genre) => !ids.includes(genre.id)), ...genres].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const allScreens = [...(previous.screens ?? []).filter((screen) => !screens.includes(screen.id)), ...shown].sort((a, b) => SCREENS.indexOf(a.id) - SCREENS.indexOf(b.id));
  const report = {
    device: 'IWER metaQuest2, stereo, 1280×720 page',
    renderer: browserRenderer().mode,
    budget: QUEST2_BUDGET,
    profile: XR_QUALITY,
    ticks: TICKS,
    every: EVERY,
    genres: all,
    screens: allScreens,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`→ ${out}`);
  printTable(report);
}

/**
 * Řádky tabulek pro `evals/vr/README.md`; `__tests__/budget.test.ts` je porovná se souborem. Žánr: nejhorší snímek,
 * pak volání / trojúhelníky hry bez panelu, s výsledkem, s kartou sdílení, s „Comfort“ a s lobby a klávesnicí.
 */
function printTable(report) {
  const cell = (at) => (at === null ? '–' : `${String(at.calls)} / ${String(at.triangles)}`);
  for (const genre of report.genres) {
    const panels = [null, 'result', 'share', 'comfort', 'keyboard'].map((panel) => cell(panelPeak(genre.samples, panel)));
    console.log(`| \`${genre.id}\` | ${genre.kind} | ${String(genre.max.calls)} | ${String(genre.max.triangles)} | ${genre.max.textureMB.toFixed(1)} | ${panels.join(' | ')} |`);
  }
  for (const screen of report.screens) console.log(`| \`${screen.id}\` | ${screen.kind} | ${String(screen.max.calls)} | ${String(screen.max.triangles)} | ${screen.max.textureMB.toFixed(1)} |`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
