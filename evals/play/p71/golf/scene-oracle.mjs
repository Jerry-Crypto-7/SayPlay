// P71C T5 – browser oracle for timing (rope), rhythm on a phone, drawsave on a desktop and the start/end cards.
// Runs against an already running `next start` (games from `games.json`, made by `make-games.mjs` on the same server).
// Usage: node evals/play/p71/golf/scene-oracle.mjs [baseUrl]  → PNGs + `scene-oracle.json` next to this file.
//
// Scene boxes: three.js announces every Scene to `window.__THREE_DEVTOOLS__` (an init script listens), so the page
// can project the real meshes of the frog (`userData.toyHero`), the rope (`userData.rope`) and the fed one
// (`userData.goal`) with the live camera from `__playFrame().camera` – CSS px of the page.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3012';
const OUT = dirname(fileURLToPath(import.meta.url));
const { games } = JSON.parse(readFileSync(join(OUT, 'games.json'), 'utf8'));
const HZ = 60;

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const CLIP_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

// Optional 2nd argument: run only the checks whose name starts with it; the other results stay in the JSON.
const ONLY = process.argv[3];
const REPORT = join(OUT, 'scene-oracle.json');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-features=OpenXR'] });
const report = { base: BASE, ran: new Date().toISOString(), checks: ONLY !== undefined && existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')).checks : {} };

async function open(profile, url) {
  const context = await browser.newContext(profile);
  await context.addInitScript(() => {
    const scenes = [];
    const hub = new EventTarget();
    hub.addEventListener('observe', (event) => {
      if (event.detail?.isScene === true) scenes.push(event.detail);
    });
    window.__THREE_DEVTOOLS__ = hub;
    window.__oracleScenes = scenes;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_WARNING)) errors.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`http ${String(response.status())}: ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(`${BASE}${url}`);
  await page.getByTestId('arcade-stage').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playRender !== undefined && window.__playFrame?.().hero != null, undefined, { timeout: 90_000 });
  // Models loaded: the mesh count held still for 1.5 s (as `play-minigolf.spec.ts` `settled`).
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 25_000;
  while (Date.now() - since < 1500 && Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender().meshes);
    if (meshes !== last) [last, since] = [meshes, Date.now()];
    await page.waitForTimeout(250);
  }
  return { context, page, errors };
}

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
async function shot(page, name) {
  await frames(page);
  await frames(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  return `${name}.png`;
}

/** Projected boxes (CSS px of the page) of the tagged scene nodes, the stage and the start card. */
const boxes = (page) =>
  page.evaluate(() => {
    const scenes = window.__oracleScenes ?? [];
    const findIn = (root, pred) => {
      let found = null;
      root.traverse((node) => {
        if (found === null && pred(node)) found = node;
      });
      return found;
    };
    const scene = [...scenes].reverse().find((candidate) => findIn(candidate, (node) => node.userData?.frame === 'hero') !== null);
    if (scene === undefined) return { error: `no game scene among ${String(scenes.length)}` };
    const camera = window.__playFrame().camera;
    const stageEl = document.querySelector('[data-testid="arcade-stage"]');
    const canvas = stageEl.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const V = scene.position.constructor;
    const Q = scene.quaternion.constructor;
    const M = scene.matrixWorld.constructor;
    const view = new M().compose(new V(...camera.position), new Q(...camera.quaternion), new V(1, 1, 1)).invert();
    const proj = new M().fromArray(camera.projection);
    const ghostly = (node) => {
      for (let at = node; at !== null; at = at.parent) if (at.userData?.ghost !== undefined) return true;
      return false;
    };
    const shown = (node) => {
      for (let at = node; at !== null; at = at.parent) if (!at.visible) return false;
      return true;
    };
    // Silhouette box: every vertex (skinning and morphs applied by `getVertexPosition`) projected with the live camera –
    // what a person sees. The 8 corners of a rotated 3D box would overstate it by up to ~15 % on each side.
    const boxOf = (root) => {
      if (root === null) return null;
      if (!shown(root)) return { hidden: true };
      let [left, right, top, bottom, meshes, vertices, behind] = [Infinity, -Infinity, Infinity, -Infinity, 0, 0, false];
      const v = new V();
      root.traverseVisible((node) => {
        if (node.isMesh !== true || node.geometry?.attributes?.position === undefined) return;
        const count = node.geometry.attributes.position.count;
        const step = Math.max(1, Math.floor(count / 50_000));
        meshes += 1;
        for (let i = 0; i < count; i += step) {
          node.getVertexPosition(i, v);
          v.applyMatrix4(node.matrixWorld).applyMatrix4(view);
          if (v.z >= 0) behind = true;
          v.applyMatrix4(proj);
          const px = rect.left + ((v.x + 1) / 2) * rect.width;
          const py = rect.top + ((1 - v.y) / 2) * rect.height;
          [left, right, top, bottom] = [Math.min(left, px), Math.max(right, px), Math.min(top, py), Math.max(bottom, py)];
          vertices += 1;
        }
      });
      if (meshes === 0) return { meshes };
      return { left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom), width: Math.round(right - left), height: Math.round(bottom - top), meshes, vertices, behind };
    };
    const card = document.querySelector('[data-testid="play-first-prompt"]')?.getBoundingClientRect() ?? null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stage: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      card: card === null ? null : { left: Math.round(card.left), right: Math.round(card.right), top: Math.round(card.top), bottom: Math.round(card.bottom) },
      // The ghost ("Best run", `Ghost.tsx`) clones the hero with its `toyHero` tag under a `userData.ghost` group.
      hero: boxOf(findIn(scene, (node) => node.userData?.toyHero === true && !ghostly(node))),
      rope: boxOf(findIn(scene, (node) => node.userData?.rope === true)),
      goal: boxOf(findIn(scene, (node) => node.userData?.goal === true)),
      slider: boxOf(findIn(scene, (node) => node.userData?.frame === 'hero')),
      // The thing on the needle (candy under the rope): the rider group tagged `item: 'block'`.
      candy: boxOf(findIn(scene, (node) => node.userData?.item === 'block')),
      items: Object.fromEntries(Object.entries(window.__playFrame().items).map(([key, value]) => [key, value.count])),
    };
  });

/** A box inside the viewport with `margin` px to spare, and whether the start card overlaps it. */
function fit(box, viewport, card, margin = 0) {
  if (box === null || box.left === undefined) return { box, inside: false };
  const inside = box.left >= margin && box.top >= margin && box.right <= viewport.width - margin && box.bottom <= viewport.height - margin;
  const margins = { left: box.left, top: box.top, right: viewport.width - box.right, bottom: viewport.height - box.bottom };
  const underCard = card !== null && box.left < card.right && card.left < box.right && box.top < card.bottom && card.top < box.bottom;
  return { box, inside, margins, underCard };
}

const outcome = (end) => ({ runState: end.runState, tick: end.tick, seconds: Number((end.tick / HZ).toFixed(1)) });
const handPlay = async (page) => {
  const end = outcome(await page.evaluate(() => window.__playShell.handPlay('end')));
  await page.getByTestId('play-postrun').waitFor({ state: 'visible', timeout: 30_000 });
  return end;
};
const idleRun = async (page) => {
  const end = outcome(await page.evaluate(() => window.__playShell.idleRun()));
  await page.getByTestId('play-postrun').waitFor({ state: 'visible', timeout: 30_000 });
  return end;
};

/**
 * Mouse drag across a card from its top-left text to its bottom-right, then `getSelection()`. Control: the same drag
 * over a plain injected text block in the same rect must select text, so a 0 on the card is not a broken drag.
 */
async function dragSelect(page, selector) {
  const card = page.locator(selector).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  const box = await card.boundingBox();
  const drag = async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(box.x + 12, box.y + 14);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 12, box.y + box.height - 14, { steps: 20 });
    await page.mouse.up();
    return page.evaluate(() => window.getSelection()?.toString() ?? '');
  };
  const userSelect = await card.evaluate((node) => getComputedStyle(node).userSelect);
  const selected = await drag();
  const cardVisibleAfter = await card.isVisible();
  await page.evaluate((at) => {
    const probe = document.createElement('div');
    probe.id = 'oracle-select-control';
    probe.textContent = 'Control text that a normal drag selects. '.repeat(6);
    Object.assign(probe.style, { position: 'fixed', left: `${at.x}px`, top: `${at.y}px`, width: `${at.width}px`, height: `${at.height}px`, zIndex: '2147483647', background: '#fff', color: '#000', font: '16px sans-serif', userSelect: 'text', pointerEvents: 'auto', overflow: 'hidden' });
    document.body.appendChild(probe);
  }, box);
  const control = await drag();
  await page.evaluate(() => {
    document.getElementById('oracle-select-control')?.remove();
    window.getSelection()?.removeAllRanges();
  });
  return { selector, userSelect, selectedLength: selected.length, selected: selected.slice(0, 80), cardVisibleAfter, controlLength: control.length, rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
}

/** Drawsave grid from `data-lane-cells` (cols, rows, left, top, right, bottom as shares of the stage). */
async function grid(page) {
  const stage = page.getByTestId('arcade-stage');
  const attr = (await stage.getAttribute('data-lane-cells')) ?? '';
  const [cols, rows, left, top, right, bottom] = attr.split(',').map(Number);
  const box = await stage.boundingBox();
  const px = { left: box.x + left * box.width, right: box.x + right * box.width, top: box.y + top * box.height, bottom: box.y + bottom * box.height };
  const height = px.bottom - px.top;
  return {
    cols,
    rows,
    px: Object.fromEntries(Object.entries(px).map(([key, value]) => [key, Math.round(value)])),
    heightPx: Math.round(height),
    stageHeightPx: Math.round(box.height),
    shareOfStage: Number((height / box.height).toFixed(3)),
    cellPx: Number(((px.right - px.left) / cols).toFixed(1)),
  };
}

async function check(name, run) {
  if (ONLY !== undefined && !name.startsWith(ONLY)) return;
  console.log(`-- ${name}`);
  // `/api/play/*` allows 50 requests per 10 s per address; back-to-back page loads hit it (HTTP 429 in the console).
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  try {
    report.checks[name] = await run();
  } catch (error) {
    report.checks[name] = { error: String(error?.stack ?? error) };
  }
  console.log(JSON.stringify(report.checks[name]));
  writeFileSync(join(OUT, 'scene-oracle.json'), `${JSON.stringify(report, null, 1)}\n`);
}

// 2. Timing – rope and monster on the start screen (phone and desktop), the bot wins, the idle player loses.
for (const [profileName, profile] of [['phone', PHONE], ['desk', DESK]]) {
  await check(`timing-rope-${profileName}`, async () => {
    const { context, page, errors } = await open(profile, games['timing-rope'].url);
    const at = await boxes(page);
    const shots = [await shot(page, `timing-rope-${profileName}-start`)];
    const result = {
      sentence: games['timing-rope'].sentence,
      viewport: profile.viewport,
      rope: fit(at.rope, at.viewport, at.card),
      monster: fit(at.goal, at.viewport, at.card),
      slider: fit(at.slider, at.viewport, at.card),
      candy: fit(at.candy, at.viewport, at.card),
      card: at.card,
      items: at.items,
      error: at.error,
    };
    if (profileName === 'desk') result.startCardSelection = await dragSelect(page, '[data-testid="play-first-prompt"]');
    result.handPlay = await handPlay(page);
    shots.push(await shot(page, `timing-rope-${profileName}-end`));
    result.idleRun = await idleRun(page);
    if (profileName === 'desk') {
      result.lostCardSelection = await dragSelect(page, '[data-testid="play-postrun"]');
      shots.push(await shot(page, `timing-rope-${profileName}-lost`));
    }
    await context.close();
    return { ...result, shots, errors };
  });
}
for (const key of ['timing-platform', 'timing-pancakes']) {
  await check(`${key}-desk`, async () => {
    const { context, page, errors } = await open(DESK, games[key].url);
    const shots = [await shot(page, `${key}-desk-start`)];
    const result = { sentence: games[key].sentence, viewport: DESK.viewport, handPlay: await handPlay(page) };
    shots.push(await shot(page, `${key}-desk-end`));
    result.idleRun = await idleRun(page);
    await context.close();
    return { ...result, shots, errors };
  });
}

// 3. Rhythm on a phone – the frog whole inside 390×844 (8 px margin) at start, after real taps and at the end.
await check('rhythm-phone', async () => {
  const { context, page, errors } = await open(PHONE, games.rhythm.url);
  const frog = async () => {
    const at = await boxes(page);
    const camera = await page.evaluate(() => window.__playFrame().camera.position.map((value) => Number(value.toFixed(2))));
    return { ...fit(at.hero, at.viewport, at.card, 8), card: at.card, camera, error: at.error };
  };
  const result = { sentence: games.rhythm.sentence, viewport: PHONE.viewport, start: await frog() };
  const shots = [await shot(page, 'rhythm-phone-start')];
  const stage = await page.getByTestId('arcade-stage').boundingBox();
  // First tap starts; then for ~6 s a tap across the four lanes near the bar every ~250 ms, the frog sampled after each
  // (it dances to the beat, so one frame is not enough).
  await page.touchscreen.tap(stage.x + stage.width / 2, stage.y + stage.height * 0.6);
  await page.waitForTimeout(400);
  const samples = [];
  for (let k = 0; k < 24; k += 1) {
    await page.touchscreen.tap(stage.x + stage.width * (0.125 + 0.25 * (k % 4)), stage.y + stage.height * 0.72);
    await page.waitForTimeout(150);
    const sample = await frog();
    if (sample.box?.left !== undefined) samples.push({ ...sample.margins, inside: sample.inside, underCard: sample.underCard });
    if (k === 8) {
      result.tickAfterTaps = await page.evaluate(() => window.__playShell.tick());
      result.input = sample;
      shots.push(await shot(page, 'rhythm-phone-input'));
    }
  }
  result.playSamples = {
    count: samples.length,
    outside8px: samples.filter((sample) => !sample.inside).length,
    minMargin: Object.fromEntries(['left', 'top', 'right', 'bottom'].map((side) => [side, Math.min(...samples.map((sample) => sample[side]))])),
    underCard: samples.filter((sample) => sample.underCard).length,
  };
  result.tickAfterSampling = await page.evaluate(() => window.__playShell.tick());
  result.handPlay = await handPlay(page);
  result.end = await frog();
  shots.push(await shot(page, 'rhythm-phone-end'));
  // The end camera differs from the play camera: does the next run (Play again) keep it?
  await page.getByTestId('play-postrun').getByRole('button', { name: 'Play again' }).click();
  await page.waitForTimeout(2000);
  result.playAgain = await frog();
  shots.push(await shot(page, 'rhythm-phone-again'));
  result.idleRun = await idleRun(page);
  await context.close();
  return { ...result, shots, errors };
});

// 4. Drawsave on a desktop – the grid fills ≥ 60 % of the play height; a real mouse draws a wall; the bot wins.
await check('drawsave-desk', async () => {
  const { context, page, errors } = await open(DESK, games.drawsave.url);
  const result = { sentence: games.drawsave.sentence, viewport: DESK.viewport, gridStart: await grid(page) };
  const shots = [await shot(page, 'drawsave-desk-start')];
  result.startCardSelection = await dragSelect(page, '[data-testid="play-first-prompt"]');
  await page.evaluate(() => window.__playShell.start());
  await page.waitForTimeout(300);
  const g = result.gridStart;
  const cell = (g.px.right - g.px.left) / g.cols;
  const rowY = g.px.top + cell * 6.5;
  await page.mouse.move(g.px.left + cell * 1.5, rowY);
  await page.mouse.down();
  await page.mouse.move(g.px.left + cell * 6.5, rowY, { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  result.tickAfterDraw = await page.evaluate(() => window.__playShell.tick());
  // The drag reached the game: HOLD inputs (`BUTTON.HOLD` = 1 << 5) recorded by the session.
  result.drawInputs = await page.evaluate(() => window.__playShell.capture().inputs.filter((event) => (event.buttons & (1 << 5)) !== 0).length);
  result.gridInput = await grid(page);
  shots.push(await shot(page, 'drawsave-desk-input'));
  result.handPlay = await handPlay(page);
  shots.push(await shot(page, 'drawsave-desk-end'));
  result.idleRun = await idleRun(page);
  result.lostCardSelection = await dragSelect(page, '[data-testid="play-postrun"]');
  shots.push(await shot(page, 'drawsave-desk-lost'));
  await context.close();
  return { ...result, shots, errors };
});

await browser.close();
writeFileSync(join(OUT, 'scene-oracle.json'), `${JSON.stringify(report, null, 1)}\n`);
