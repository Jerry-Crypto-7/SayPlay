/**
 * Vlastní panorama pro neznámé prostředí (P29C T7). Služba `ops/env/server.py`
 * je tu stub nad `fetch`: počítá dotazy, kontroluje klíč a vrací, co scénář
 * řekne. Hlídá se: publikace založí úlohu jen pro prostředí mimo knihovnu,
 * route vrací stav a soubory, klíč nikdy neodejde ven a bez služby nebo po
 * chybě zůstává knihovní panorama.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingInLibrary } from '@/play/arcade/look/env';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { needsCustomEnv, serviceSetting } from '../_env';
import { POST as createGame } from '../games/route';
import { GET as readEnv } from '../games/[id]/env/route';

const ENDPOINT = 'http://env.test:8793';
const KEY = 'secret-env-key-123';
const UNKNOWN = 'inside a giant cuckoo clock';
const KNOWN = 'a snowy forest';
const IMAGE = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

interface Stub {
  status: 'queued' | 'running' | 'done' | 'failed';
  /** Všechny dotazy na službu: cesta, tělo, klíč. */
  calls: { path: string; body: unknown; key: string | null }[];
  /** Služba mlčí (síťová chyba). */
  down: boolean;
  /** Jméno souboru, které služba vrátí u hotové úlohy (porucha = cesta ven). */
  file: string;
}

const stub: Stub = { status: 'running', calls: [], down: false, file: 'inside-a-giant-cuckoo-clock.webp' };

function service(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  stub.calls.push({ path: url.pathname, body: init?.body === undefined ? null : JSON.parse(String(init.body)), key: headers.get('x-env-key') });
  if (stub.down) return Promise.reject(new TypeError('fetch failed'));
  if (headers.get('x-env-key') !== KEY) return Promise.resolve(Response.json({ detail: 'missing or wrong X-Env-Key' }, { status: 401 }));
  if (url.pathname === '/panorama') return Promise.resolve(Response.json({ jobId: 'abc123' }));
  if (url.pathname === '/jobs/abc123') {
    const done = stub.status === 'done' ? { id: 'inside-a-giant-cuckoo-clock', file: stub.file, low: 'inside-a-giant-cuckoo-clock-low.webp', horizon: '#a1b2c3' } : {};
    return Promise.resolve(Response.json({ jobId: 'abc123', setting: UNKNOWN, status: stub.status, ...done }));
  }
  if (url.pathname.startsWith('/files/')) return Promise.resolve(new Response(IMAGE, { headers: { 'content-type': 'image/webp' } }));
  return Promise.resolve(Response.json({ detail: 'unknown' }, { status: 404 }));
}

const runner = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/runner.json'), 'utf8')) as { theme: Record<string, unknown> };

async function publish(setting: string): Promise<string> {
  const response = await createGame(
    new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ spec: { ...runner, theme: { ...runner.theme, setting } } }),
    }),
  );
  // Tělo jen jednou: `clone()` + druhé čtení občas padalo na „Body has already been read“.
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  // Úloha jde po odpovědi (`after()` v testu nejde, práce doběhne sama) – nech ji doběhnout.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return (JSON.parse(text) as { versionId: string }).versionId;
}

async function env(id: string, query = ''): Promise<Response> {
  return readEnv(new Request(`http://play.test/api/play/games/${id}/env${query}`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  Object.assign(stub, { status: 'running', calls: [], down: false, file: 'inside-a-giant-cuckoo-clock.webp' });
  process.env.PLAY_ENV_ENDPOINT = `${ENDPOINT}/`;
  process.env.PLAY_ENV_KEY = KEY;
  vi.stubGlobal('fetch', vi.fn(service));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PLAY_ENV_ENDPOINT;
  delete process.env.PLAY_ENV_KEY;
  delete process.env.WORLDSMITH_CONTROL_FILE;
});

describe('which settings need a custom panorama', () => {
  it('only settings the library does not know', () => {
    expect(settingInLibrary(UNKNOWN)).toBe(false);
    expect(needsCustomEnv(UNKNOWN)).toBe(true);
    expect(needsCustomEnv(KNOWN)).toBe(false);
  });

  it('sends the service only what its pattern accepts', () => {
    expect(serviceSetting('  Über-CASTLE!! on Mars ')).toBe('ber-castle on mars');
    expect(serviceSetting('***')).toBeNull();
    expect(serviceSetting('x'.repeat(200))).toHaveLength(80);
    expect(serviceSetting("-- a dragon's lair")).toBe("a dragon's lair");
  });
});

describe('publish', () => {
  it('starts a job for an unknown setting, with the key and the cleaned setting', async () => {
    await publish(UNKNOWN);
    expect(stub.calls).toEqual([{ path: '/panorama', body: { setting: UNKNOWN }, key: KEY }]);
  });

  it('does not call the service for a setting the library knows', async () => {
    await publish(KNOWN);
    expect(stub.calls).toEqual([]);
  });

  it('publishes normally when the service is down', async () => {
    stub.down = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await publish(UNKNOWN);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('does not call the service when it is not configured', async () => {
    delete process.env.PLAY_ENV_KEY;
    await publish(UNKNOWN);
    expect(stub.calls).toEqual([]);
  });
});

describe('GET /api/play/games/:id/env', () => {
  it('says library for a setting the library knows', async () => {
    const id = await publish(KNOWN);
    expect(await (await env(id)).json()).toEqual({ status: 'library' });
  });

  it('says pending while the service works, ready with files when done', async () => {
    const id = await publish(UNKNOWN);
    expect(await (await env(id)).json()).toEqual({ status: 'pending' });
    stub.status = 'done';
    const ready = await env(id);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(await ready.json()).toEqual({
      status: 'ready',
      id: 'custom-inside-a-giant-cuckoo-clock',
      horizon: '#a1b2c3',
      url: `/api/play/games/${id}/env?file=full`,
      low: `/api/play/games/${id}/env?file=low`,
    });
  });

  it('proxies both files once ready, and only then', async () => {
    const id = await publish(UNKNOWN);
    expect((await env(id, '?file=full')).status).toBe(404);
    stub.status = 'done';
    const full = await env(id, '?file=full');
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(IMAGE);
    expect((await env(id, '?file=low')).status).toBe(200);
    const files = stub.calls.filter((call) => call.path.startsWith('/files/')).map((call) => call.path);
    expect(files).toEqual(['/files/inside-a-giant-cuckoo-clock.webp', '/files/inside-a-giant-cuckoo-clock-low.webp']);
    expect((await env(id, '?file=../../secret')).status).toBe(404);
  });

  it('keeps the library panorama when the job fails or the service is gone', async () => {
    const id = await publish(UNKNOWN);
    stub.status = 'failed';
    expect(await (await env(id)).json()).toEqual({ status: 'failed' });
    stub.down = true;
    expect(await (await env(id)).json()).toEqual({ status: 'unavailable' });
    expect((await env(id, '?file=full')).status).toBe(404);
    delete process.env.PLAY_ENV_ENDPOINT;
    expect(await (await env(id)).json()).toEqual({ status: 'unavailable' });
  });

  it('falls back to the nearest pre-baked panorama at its static address when the service fails or is gone', async () => {
    const id = await publish('a breakfast table');
    const baked = { status: 'ready', id: 'baked-breakfast-table', url: '/play/env/breakfast-table.webp', low: '/play/env/breakfast-table-low.webp' };
    stub.status = 'failed';
    expect(await (await env(id)).json()).toMatchObject(baked);
    delete process.env.PLAY_ENV_ENDPOINT;
    expect(await (await env(id)).json()).toMatchObject(baked);
  });

  it('refuses a finished job whose file name is not a plain panorama name', async () => {
    const id = await publish(UNKNOWN);
    stub.status = 'done';
    stub.file = '../../ops/env/.env.webp';
    expect(await (await env(id)).json()).toEqual({ status: 'failed' });
    expect((await env(id, '?file=full')).status).toBe(404);
    expect(stub.calls.some((call) => call.path.startsWith('/files/'))).toBe(false);
  });

  it('treats a wrong key at the service as unavailable', async () => {
    const id = await publish(UNKNOWN);
    process.env.PLAY_ENV_KEY = 'wrong';
    expect(await (await env(id)).json()).toEqual({ status: 'unavailable' });
  });

  it('never puts the service key or address into a response', async () => {
    const id = await publish(UNKNOWN);
    stub.status = 'done';
    for (const query of ['', '?file=full', '?file=nope']) {
      const text = new TextDecoder().decode(await (await env(id, query)).arrayBuffer());
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('env.test');
    }
  });

  it('is 404 for a game that does not exist or an id that cannot be one', async () => {
    expect((await env('deadbeefdeadbeef')).status).toBe(404);
    expect((await env('not-an-id')).status).toBe(404);
    expect(stub.calls).toEqual([]);
  });
});

describe('kill switch', () => {
  function switchOff(...off: string[]) {
    const file = join(mkdtempSync(join(tmpdir(), 'env-kill-')), 'control.json');
    writeFileSync(file, JSON.stringify({ off }));
    process.env.WORLDSMITH_CONTROL_FILE = file;
  }

  it('env off: publishing starts no job and the route never asks the service', async () => {
    switchOff('env');
    const id = await publish(UNKNOWN);
    stub.status = 'done';
    expect(await (await env(id)).json()).toEqual({ status: 'unavailable' });
    expect((await env(id, '?file=full')).status).toBe(404);
    expect(stub.calls).toEqual([]);
  });

  it('another lever leaves the panorama generation running', async () => {
    switchOff('feed');
    await publish(UNKNOWN);
    expect(stub.calls.map((call) => call.path)).toEqual(['/panorama']);
  });
});
