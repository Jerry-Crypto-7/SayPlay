#!/usr/bin/env node
/**
 * Rozpočet snímku ve VR (P65 T6): všech 19 žánrů v emulátoru IWER (Quest 2, dvě oči), na produkčním buildu.
 * Každý žánr se publikuje z živé buňky (`liveCells`, jako e2e `vr-native` a `vr-diorama`), stránka s `?vr=1`
 * vstoupí do VR a robot ověřovače (`botWants`) hraje s ručními hodinami (`byHand`) až `TICKS` tiků. Každých
 * `EVERY` tiků se zapíše jeden snímek: draw cally a trojúhelníky z `renderer.info` (sonda `__playRender`, obě oči
 * dohromady), počet textur a paměť textur a render bufferů na GPU (obal volání WebGL, sčítá skutečné alokace).
 *
 * Čísla jsou deterministická: stejný build, stejná hra a týž robot dají tatáž čísla, proto v souboru není čas.
 * FPS emulátor neměří – GPU je tohoto stroje, ne Questu; FPS z brýlí dává ruční brána T8.
 *
 *   npm run build
 *   PLAY_STORE_DIR=D:/caches/p65/store node node_modules/next/dist/bin/next start -p 3165 -H 127.0.0.1
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/vr/budget.mjs [--base http://127.0.0.1:3165] [--out evals/vr/budget.json] [--genres runner.default,shooter.default]
 *
 * `--genres` změří jen vyjmenované žánry; ostatní zůstanou v souboru z minulého měření (P67 T6).
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

const kindOf = (id) => (NATIVE.includes(id) ? 'native' : ROOM.includes(id) ? 'room' : SURROUND.includes(id) ? 'surround' : 'diorama');

/** 10 s hry; snímek každou půlsekundu. */
const TICKS = 600;
const EVERY = 30;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const base = arg('base', 'http://127.0.0.1:3165');
const out = resolve(ROOT, arg('out', 'evals/vr/budget.json'));
const only = arg('genres', null)?.split(',');

/** Sklon hlavy dolů na střed desky, nebo pódia tratí (rad), jako `vr-diorama.spec.ts`. */
const PITCH = { diorama: Math.atan2(1.6 - TABLE.top, -TABLE.z), surround: Math.atan2(1.6 - STAGE.top, -STAGE.z) };

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
}

function withQuest2(pitch) {
  const device = new window.IWER.XRDevice(window.IWER.metaQuest2);
  device.stereoEnabled = true;
  device.installRuntime({ forceInstall: true });
  device.position.set(0, 1.6, 0);
  device.quaternion.set(-Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
  // Paprsek pravého ovladače svisle nahoru: na stůl ani na pruhy nemíří, hraje robot.
  device.controllers.right?.position.set(0.25, 1.2, -0.25);
  device.controllers.right?.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  device.controllers.left?.position.set(-0.3, 1.1, -0.4);
  device.controllers.left?.quaternion.set(0, 0, 0, 1);
}

/** MB na jedno desetinné místo. */
const tenth = (value) => Math.round(value * 10) / 10;

async function publish(id) {
  const cell = liveCells().find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`${id} is not a live cell`);
  const response = await fetch(new URL('/api/play/games', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: compileRecipe(assemblyOfCell(cell)) }) });
  if (!response.ok) throw new Error(`${id}: publish ${String(response.status)} ${await response.text()}`);
  return /** @type {{ url: string }} */ (await response.json()).url;
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

async function measure(browser, id) {
  const kind = kindOf(id);
  const url = await publish(id);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  // Chyby stránky i snímků VR: `KeepXrFrames` (`XrRoot`) snímek s výjimkou zahodí a hlásí ji jen do konzole.
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
  // VR-nativní žánry a svět kolem hráče: hlava rovně jako v `vr-native.spec.ts` a `vr-room.spec.ts`; diorama a pódium: pohled na střed.
  await page.addInitScript(withQuest2, PITCH[kind] ?? 0);
  await page.goto(new URL(`${url}?vr=1`, base).href);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await page.evaluate(() => window.__playShell.byHand(true));
  // Relaci jde začít, až plátno XR stojí (sonda `__playXr` žije uvnitř `<XR>`); klik před tím se ztratí.
  await page.waitForFunction(() => window.__playXr !== undefined && window.__playRender !== undefined, undefined, { timeout: 30_000 });
  for (let attempt = 1; ; attempt += 1) {
    await page.getByTestId('enter-vr').click();
    const entered = await page.waitForFunction(() => window.__playXr?.().presenting === true, undefined, { timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    if (entered) break;
    if (attempt === 3) throw new Error(`${id}: no VR session after ${String(attempt)} clicks; page errors: ${errors.join(' | ') || 'none'}`);
  }
  const ready = await settled(page);

  const played = await page.evaluate(
    async ({ ticks, every }) => {
      const frames = (count) =>
        new Promise((done) => {
          const next = (left) => (left === 0 ? done() : requestAnimationFrame(() => next(left - 1)));
          next(count);
        });
      const shell = window.__playShell;
      const sample = (tick) => {
        const render = window.__playRender();
        const xr = window.__playXr();
        const gpu = window.__gpuBytes();
        return {
          tick,
          calls: render.calls,
          triangles: render.triangles,
          textures: render.textures,
          textureMB: gpu.textures / (1024 * 1024),
          renderbufferMB: gpu.renderbuffers / (1024 * 1024),
          presenting: xr.presenting,
          eyes: xr.eyes,
          quality:document.querySelector('[data-quality]')?.getAttribute('data-quality') ?? null,
        };
      };
      const samples = [];
      let end = null;
      for (let tick = 0; tick < ticks && (end === null || end.runState === 'running'); tick += 1) {
        const want = shell.botWants();
        shell.hold(want?.axis ?? 0);
        shell.press(want?.buttons ?? 0);
        end = shell.tickByHand();
        await frames(1);
        if ((tick + 1) % every === 0) {
          await frames(2);
          samples.push(sample(end.tick));
        }
      }
      // Konec hry: výsledek na zamrzlé scéně je také snímek, který brýle kreslí.
      await frames(3);
      samples.push(sample(end.tick));
      return { end, samples };
    },
    { ticks: TICKS, every: EVERY },
  );
  const desk = await page.evaluate(() => window.__playXr().desk?.scale ?? null);
  const room = await page.evaluate(() => window.__playXr().room?.scale ?? null);
  await context.close();

  const { samples } = played;
  const lost = samples.filter((sample) => !sample.presenting || sample.eyes !== 2);
  if (lost.length > 0) throw new Error(`${id}: ${String(lost.length)} samples outside a two-eye session`);
  return {
    id,
    kind,
    scale: desk === null ? (room === null ? null : `1:${(1 / room).toFixed(1)}`) : `1:${(1 / desk).toFixed(1)}`,
    settled: ready,
    end: { runState: played.end.runState, tick: played.end.tick, score: played.end.score },
    errors,
    samples: samples.map((sample) => ({ ...sample, textureMB: tenth(sample.textureMB), renderbufferMB: tenth(sample.renderbufferMB) })),
  };
}

/** Nejvyšší hodnota pole přes snímky – rozpočet platí pro nejhorší snímek. */
export const peak = (samples, field) => Math.max(...samples.map((sample) => sample[field]));

async function main() {
  const order = [...NATIVE, ...ROOM, ...SURROUND, ...DIORAMA];
  const ids = order.filter((id) => only === undefined || only.includes(id));
  // Bez OpenXR runtime počítače (SteamVR by hlásil immersive-vr i bez brýlí); brýle hraje IWER, jako v `playwright.config.ts`.
  const browser = await chromium.launch({ args: [...browserRenderer().args, '--disable-features=OpenXR'] });
  const genres = [];
  try {
    for (const id of ids) {
      const started = Date.now();
      // Jedno opakování: emulátor občas relaci nezačne; druhé selhání shodí běh, ať soubor nemá díru.
      const genre = await measure(browser, id).catch((error) => {
        console.log(`${id}: ${String(error).split('\n')[0]} – once more`);
        return measure(browser, id);
      });
      genres.push({ ...genre, max: { calls: peak(genre.samples, 'calls'), triangles: peak(genre.samples, 'triangles'), textureMB: peak(genre.samples, 'textureMB') } });
      console.log(`${id.padEnd(20)} calls ${String(genres.at(-1).max.calls).padStart(4)}  triangles ${String(genres.at(-1).max.triangles).padStart(7)}  textures ${genres.at(-1).max.textureMB.toFixed(1)} MB  ${genre.end.runState}@${String(genre.end.tick)}  ${String(Math.round((Date.now() - started) / 1000))} s${genre.errors.length > 0 ? `  errors: ${genre.errors.join(' | ')}` : ''}`);
    }
  } finally {
    await browser.close();
  }
  // Zúžený běh: nezměřené žánry zůstanou z minulého měření, pořadí podle rozdělení.
  const kept = only === undefined || !existsSync(out) ? [] : JSON.parse(readFileSync(out, 'utf8')).genres.filter((genre) => !ids.includes(genre.id));
  const all = [...kept, ...genres].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const report = {
    device: 'IWER metaQuest2, stereo, 1280×720 page',
    renderer: browserRenderer().mode,
    budget: QUEST2_BUDGET,
    profile: XR_QUALITY,
    ticks: TICKS,
    every: EVERY,
    genres: all,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`→ ${out}`);
  // Řádky tabulky pro `evals/vr/README.md`; `__tests__/budget.test.ts` je porovná se souborem.
  for (const genre of all) console.log(`| \`${genre.id}\` | ${genre.kind} | ${String(genre.max.calls)} | ${String(genre.max.triangles)} | ${genre.max.textureMB.toFixed(1)} |`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
