/**
 * Harness snímků a časů P32 (`scripts/p32/shots.mjs`) proti dvojníkovi stránky:
 * lokální statické HTML, které se chová jako `/play` → `/play/<id>` a nese
 * tytéž sondy (`arcade-stage`, `data-input-tick`, plátno WebGL, proužek AI verze).
 *
 * Hlídaná vlastnost: čas do ovladatelné hry se měří od kliknutí k sondě
 * „jádro zpracovalo vstup“ – ne k prvnímu snímku. Dvojník přijme vstup až
 * `ACCEPT_MS` po zobrazení plátna; bez sondy měření selže, nenahradí se.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { categoryOf, parseArgs, shoot } from '../p32/shots.mjs';

/** Mezi kliknutím a plátnem (server + navigace) a mezi plátnem a prvním přijatým vstupem. */
const NAVIGATE_MS = 200;
const ACCEPT_MS = 700;

/**
 * `arcade`: sonda `data-input-tick` na `arcade-stage`. `noprobe`: arkáda bez ní.
 * `grid`: mřížková hra – `play-grid-stage`, karta cíle a záznam vstupů v `__playShell`.
 */
function page(mode: 'arcade' | 'noprobe' | 'grid'): string {
  return `<!doctype html><html><body style="margin:0;background:#123">
<div id="form"><textarea data-testid="play-sentence"></textarea><button data-testid="play-create">Play it</button></div>
<div id="root"></div>
<script>
const MODE = '${mode}';
const PROBE = MODE === 'arcade';
function stage(id) {
  document.getElementById('form')?.remove();
  const root = document.getElementById('root');
  root.innerHTML = '';
  const el = document.createElement('div');
  el.dataset.testid = MODE === 'grid' ? 'play-grid-stage' : 'arcade-stage';
  if (MODE === 'grid') {
    const log = [];
    window.__playShell = { inputs: () => log };
    const card = document.createElement('button');
    card.dataset.testid = 'play-target-a';
    card.textContent = 'snowflake GO';
    // Runtime přijme akci, až je svět postavený – dřív ji odmítne a nezapíše.
    card.onclick = () => { if (Date.now() - born >= ${String(ACCEPT_MS)}) log.push({ tick: 4, actionId: 'moveTo' }); };
    root.appendChild(card);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  el.appendChild(canvas);
  root.appendChild(el);
  const gl = canvas.getContext('webgl');
  (function frame() { gl.clearColor(0.2, 0.5, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1); requestAnimationFrame(frame); })();
  const born = Date.now();
  let tick = 0;
  setInterval(() => (tick += 1), 16);
  window.addEventListener('keydown', () => {
    if (!PROBE || el.hasAttribute('data-input-tick') || Date.now() - born < ${String(ACCEPT_MS)}) return;
    el.setAttribute('data-input-tick', String(tick));
    el.setAttribute('data-input-at', String(Date.now()));
  });
  const up = document.createElement('aside');
  up.dataset.testid = 'upgrade-state';
  up.dataset.kind = 'working';
  root.appendChild(up);
  if (id === 'abc123') setTimeout(() => {
    up.dataset.kind = 'ready';
    const go = document.createElement('button');
    go.dataset.testid = 'upgrade-action';
    go.textContent = 'Play the AI version';
    go.onclick = () => { history.pushState({}, '', '/play/def456'); stage('def456'); };
    up.appendChild(go);
  }, 300);
}
document.querySelector('[data-testid="play-create"]').onclick = async () => {
  await fetch('/api/play/games', { method: 'POST', body: document.querySelector('textarea').value });
  setTimeout(() => { history.pushState({}, '', '/play/abc123'); stage('abc123'); }, ${String(NAVIGATE_MS)});
};
const at = location.pathname.match(/^\\/play\\/([0-9a-f]+)$/);
if (at) stage(at[1]);
</script></body></html>`;
}

function double(mode: 'arcade' | 'noprobe' | 'grid'): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"url":"/play/abc123"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page(mode));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` })));
}

let dir: string;
let set: string;
let withProbe: { server: Server; base: string };
let withoutProbe: { server: Server; base: string };
let grid: { server: Server; base: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'p32-shots-'));
  set = join(dir, 'sentences.json');
  writeFileSync(set, JSON.stringify({ sentences: [{ id: 'penguin', text: 'A penguin slides down an icy mountain' }, 'A chef cooks pancakes'], sealed: [] }));
  [withProbe, withoutProbe, grid] = await Promise.all([double('arcade'), double('noprobe'), double('grid')]);
});

afterAll(() => {
  for (const one of [withProbe, withoutProbe, grid]) one.server.close();
  rmSync(dir, { recursive: true, force: true });
});

const isPng = (file: string): boolean => existsSync(file) && readFileSync(file).subarray(1, 4).toString() === 'PNG';

describe('parseArgs', () => {
  it('reads the flags and fills the defaults', () => {
    expect(parseArgs(['--base', 'http://127.0.0.1:3354/', '--set', 's.json', '--out', 'runs/x'])).toEqual({
      base: 'http://127.0.0.1:3354',
      set: 's.json',
      out: 'runs/x',
      live: false,
      limit: null,
      fpsSeconds: 20,
      playableTimeoutMs: 60_000,
    });
    expect(parseArgs(['--base', 'http://h', '--set', 's', '--out', 'o', '--live', '--limit', '1', '--fps-seconds', '3', '--playable-timeout-ms', '900'])).toMatchObject({
      live: true,
      limit: 1,
      fpsSeconds: 3,
      playableTimeoutMs: 900,
    });
  });

  it('refuses a missing required flag, an unknown flag and a non-number', () => {
    expect(() => parseArgs(['--set', 's', '--out', 'o'])).toThrow(/--base/);
    expect(() => parseArgs(['--base', 'http://h', '--set', 's', '--out', 'o', '--fast'])).toThrow(/--fast/);
    expect(() => parseArgs(['--base', 'http://h', '--set', 's', '--out', 'o', '--limit', 'two'])).toThrow(/--limit/);
  });
});

describe('categoryOf', () => {
  it('sorts the network log into loading phases', () => {
    expect(categoryOf('http://h/play/abc', 'document')).toBe('html');
    expect(categoryOf('http://h/_next/static/chunks/12.js', 'script')).toBe('js');
    expect(categoryOf('http://h/api/play/games', 'fetch')).toBe('api');
    expect(categoryOf('http://h/assets/worldstream/gen3d/penguin-lod0.glb', 'fetch')).toBe('glb');
    expect(categoryOf('http://h/assets/worldstream/env/snow.webp', 'image')).toBe('panorama');
    expect(categoryOf('http://h/_next/static/media/rapier_wasm3d_bg.wasm', 'fetch')).toBe('rapier');
  });
});

describe('shoot', () => {
  it('times click → input probe, click → first frame, shoots draft and AI and writes result.json', async () => {
    const out = join(dir, 'live');
    const result = await shoot({ base: withProbe.base, set, out, live: true, limit: 1, fpsSeconds: 2, playableTimeoutMs: 15_000 }, { log: () => {} });
    expect(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))).toEqual(result);
    expect(result).toMatchObject({ schema: 'p32-shots/1', live: true });
    expect(result.sentences).toHaveLength(1);
    const [one] = result.sentences;
    expect(one).toMatchObject({ id: 'penguin', text: 'A penguin slides down an icy mountain', error: null, gamePath: '/play/abc123', probe: 'arcade-stage' });
    // Vstup jde až ACCEPT_MS po plátně: čas k prvnímu snímku by vyšel o ACCEPT_MS kratší.
    expect(one.timeToFirstFrameMs).toBeGreaterThanOrEqual(NAVIGATE_MS);
    expect(one.timeToPlayableMs).toBeGreaterThanOrEqual(NAVIGATE_MS + ACCEPT_MS);
    expect((one.timeToPlayableMs ?? 0) - (one.timeToFirstFrameMs ?? 0)).toBeGreaterThanOrEqual(ACCEPT_MS - 50);
    expect(one.timeToPlayableMs).toBeLessThan(10_000);
    expect(Number.isInteger(one.inputTick)).toBe(true);
    expect(one.fpsMedian).toBeGreaterThan(0);
    expect(one.fpsSamples.length).toBeGreaterThanOrEqual(1);
    expect(one.network.some((entry: { category: string; startMs: number }) => entry.category === 'api' && entry.startMs >= 0)).toBe(true);
    expect(one.ai).toMatchObject({ status: 'ready', gamePath: '/play/def456' });
    for (const shot of ['draftDesktop', 'draftPhone', 'aiDesktop', 'aiPhone'] as const) expect(isPng(join(out, one.shots[shot] as string))).toBe(true);
  }, 90_000);

  it('fails the sentence without the input probe instead of falling back to the first frame', async () => {
    const out = join(dir, 'noprobe');
    const result = await shoot({ base: withoutProbe.base, set, out, live: false, limit: null, fpsSeconds: 1, playableTimeoutMs: 1500 }, { log: () => {} });
    expect(result.sentences.map((s: { id: string }) => s.id)).toEqual(['penguin', 's2']);
    for (const one of result.sentences) {
      expect(one.timeToPlayableMs).toBeNull();
      expect(one.error).toMatch(/data-input-tick/);
      // Snímek a první snímek plátna se změří dál – chybí jen číslo, které bez sondy nejde poctivě říct.
      expect(one.timeToFirstFrameMs).toBeGreaterThan(0);
      expect(one.ai).toBeNull();
      expect(isPng(join(out, one.shots.draftDesktop as string))).toBe(true);
    }
  }, 90_000);

  it('times a grid game from the click to the first input its runtime logged', async () => {
    const out = join(dir, 'grid');
    const result = await shoot({ base: grid.base, set, out, live: false, limit: 1, fpsSeconds: 1, playableTimeoutMs: 15_000 }, { log: () => {} });
    const [one] = result.sentences;
    expect(one).toMatchObject({ error: null, probe: 'grid-input-log', inputTick: 4 });
    // Karta je vidět hned, runtime akci přijme až ACCEPT_MS po postavení světa.
    expect(one.timeToPlayableMs).toBeGreaterThanOrEqual(NAVIGATE_MS + ACCEPT_MS);
    expect(one.timeToPlayableMs).toBeLessThan(10_000);
    expect(one.timeToFirstFrameMs).toBeGreaterThanOrEqual(NAVIGATE_MS);
  }, 90_000);
});
