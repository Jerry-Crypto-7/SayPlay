/**
 * Sonda „čas do hratelnosti“ (P49 T2). Sonda, která měří od špatného okamžiku
 * nebo uzná statický obrázek za hru, vrátí přesvědčivé číslo, které je špatně –
 * proto dvě fixture: hra hratelná po 800 ms a plocha, která na vstup nereaguje.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { measure } from '../time-to-playable.mjs';

const FIXTURES = join(__dirname, 'fixtures');

let server: Server;
let base = '';
let scratch = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'ttp-'));
  server = createServer((request, response) => {
    const name = (request.url ?? '/').replace(/^\//, '');
    if (!/^[a-z-]+\.html(\?.*)?$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(join(FIXTURES, name)));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(scratch, { recursive: true, force: true });
});

describe('time-to-playable probe', () => {
  it('measures a game that turns playable 800 ms after navigation and records a HAR', async () => {
    const harPath = join(scratch, 'delayed.har');
    const result = await measure({ url: `${base}/delayed-game.html`, surfaceSelector: 'canvas', timeoutMs: 10_000, harPath, screenshotDir: join(scratch, 'shots'), gpu: false });

    expect(result.playable).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(600);
    expect(result.ms).toBeLessThanOrEqual(2000);
    expect(result.tPlayable! - result.t0).toBe(result.ms);
    expect(result.inputChangePct).toBeGreaterThanOrEqual(1);

    const har = JSON.parse(readFileSync(harPath, 'utf8'));
    expect(har.log.entries.some((entry: { request: { url: string } }) => entry.request.url.endsWith('/delayed-game.html'))).toBe(true);
  });

  it('a surface that never reacts to input is not playable and times out', async () => {
    const result = await measure({ url: `${base}/dead-game.html`, surfaceSelector: 'canvas', timeoutMs: 3000, gpu: false });

    expect(result.playable).toBe(false);
    expect(result.ms).toBeNull();
    expect(result.tPlayable).toBeNull();
    expect(result.note).toMatch(/never reacted/);
  });

  it('a sentence run ignores the game that was already playing before submit', async () => {
    const result = await measure({
      url: `${base}/prompt-game.html`,
      promptSelector: '#sentence',
      submitSelector: '#make',
      sentence: 'a corgi in a park',
      waitForUrl: 'game=1',
      surfaceSelector: 'canvas',
      timeoutMs: 10_000,
      gpu: false,
    });

    expect(result.playable).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(1900);
    expect(result.ms).toBeLessThanOrEqual(3500);
    expect(result.gameUrl).toMatch(/game=1$/);
  });

  it('a poster that vanishes on the first tap is not the game reacting', async () => {
    const result = await measure({ url: `${base}/poster-game.html`, surfaceSelector: 'canvas', timeoutMs: 10_000, gpu: false });

    expect(result.playable).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(1900);
    expect(result.ms).toBeLessThanOrEqual(3500);
    expect(result.confirmChangePct).toBeGreaterThanOrEqual(1);
  });

  it('a game behind an off-centre start button is measured from navigation through the click', async () => {
    const result = await measure({ url: `${base}/start-game.html`, startSelector: '#play', surfaceSelector: 'canvas', timeoutMs: 10_000, gpu: false });

    expect(result.playable).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(900);
    expect(result.ms).toBeLessThanOrEqual(3500);
  });

  it('a page without any surface reports that, not a reaction failure', async () => {
    const result = await measure({ url: `${base}/dead-game.html`, surfaceSelector: 'iframe', timeoutMs: 1500, gpu: false });

    expect(result.playable).toBe(false);
    expect(result.note).toMatch(/no surface/);
  });
});
