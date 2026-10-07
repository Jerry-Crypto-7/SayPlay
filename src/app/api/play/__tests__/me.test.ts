/**
 * `GET|PUT /api/play/me` (P44B T3): identita a přezdívka nad skutečným
 * `versionStoreFromEnv` – paměť i souborové úložiště, `NODE_ENV=production`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { issuePlayer, PLAYER_COOKIE } from '@/server/player-identity';
import { MAX_REQUESTS_PER_WINDOW, resetRateWindows } from '@/server/rate-limit';

import { NEW_PLAYERS_PER_HOUR } from '../_player';
import { GET, PUT } from '../me/route';

const SECRET = 'FIXTURE_ONLY_NOT_A_REAL_SECRET_0000000000';
const URL_ME = 'http://play.test/api/play/me';

let callers = 0;
const freshCaller = (): string => `198.51.${String(Math.floor(callers / 256) % 256)}.${String(callers++ % 256)}`;

function get(caller: string, cookie?: string): Request {
  return new Request(URL_ME, { headers: { 'x-forwarded-for': caller, ...(cookie === undefined ? {} : { cookie }) } });
}

function put(caller: string, cookie: string | undefined, body: unknown, contentType = 'application/json'): Request {
  return new Request(URL_ME, {
    method: 'PUT',
    headers: { 'x-forwarded-for': caller, 'content-type': contentType, ...(cookie === undefined ? {} : { cookie }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** `sp_player=<hodnota>` z `set-cookie` a id z ní. */
function cookieOf(response: Response): { cookie: string; id: string } {
  const header = response.headers.get('set-cookie');
  expect(header).not.toBeNull();
  const cookie = (header as string).split(';')[0] as string;
  expect(cookie.startsWith(`${PLAYER_COOKIE}=`)).toBe(true);
  return { cookie, id: cookie.slice(PLAYER_COOKIE.length + 1).split('.')[0] as string };
}

async function newPlayer(caller = freshCaller()): Promise<{ cookie: string; id: string; nickname: string; caller: string }> {
  const response = await GET(get(caller));
  expect(response.status).toBe(200);
  const { nickname } = (await response.json()) as { nickname: string };
  return { ...cookieOf(response), nickname, caller };
}

async function nicknameOf(cookie: string, caller = freshCaller()): Promise<string> {
  const response = await GET(get(caller, cookie));
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  return ((await response.json()) as { nickname: string }).nickname;
}

const dirs: string[] = [];

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PLAY_IDENTITY_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetProcessVersionStore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(['memory', 'file'])('GET and PUT /api/play/me over the %s store', (kind) => {
  beforeEach(() => {
    if (kind === 'file') {
      const dir = mkdtempSync(join(tmpdir(), 'p44b-me-'));
      dirs.push(dir);
      vi.stubEnv('PLAY_STORE_DIR', dir);
    }
  });

  it('GET without a cookie issues a signed HttpOnly cookie and a default name, never the id in the body', async () => {
    const response = await GET(get(freshCaller()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const header = response.headers.get('set-cookie') as string;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    const { cookie, id } = cookieOf(response);
    const text = await response.text();
    expect(text).not.toContain(id);
    expect(text).not.toContain(cookie.split('=')[1]?.split('.')[1] as string);
    expect(JSON.parse(text)).toEqual({ nickname: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+$/) });
  });

  it('GET with the cookie keeps the same player and name, issuing nothing new', async () => {
    const player = await newPlayer();
    expect(await nicknameOf(player.cookie)).toBe(player.nickname);
  });

  it('PUT with the valid cookie changes the name the next GET shows; the body never carries the id', async () => {
    const player = await newPlayer();
    const response = await PUT(put(freshCaller(), player.cookie, { nickname: '  Ada  ' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(player.id);
    expect(JSON.parse(text)).toEqual({ nickname: 'Ada' });
    expect(await nicknameOf(player.cookie)).toBe('Ada');
  });

  it('PUT without a cookie or with a forged one is 403, issues no cookie and leaves the name', async () => {
    const player = await newPlayer();
    await PUT(put(freshCaller(), player.cookie, { nickname: 'Ada' }));
    const forged = issuePlayer('FIXTURE_ONLY_OTHER_FAKE_SECRET_1111111111').value;
    const sameIdForged = `${player.id}.${forged.split('.')[1] as string}`;
    for (const cookie of [undefined, `${PLAYER_COOKIE}=${forged}`, `${PLAYER_COOKIE}=${sameIdForged}`]) {
      const response = await PUT(put(freshCaller(), cookie, { nickname: 'Mallory' }));
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(await nicknameOf(player.cookie)).toBe('Ada');
  });

  it('PUT only accepts application/json', async () => {
    const player = await newPlayer();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect((await PUT(put(freshCaller(), player.cookie, { nickname: 'Mallory' }, type))).status).toBe(415);
    }
    expect((await PUT(put(freshCaller(), player.cookie, { nickname: 'Bo' }, 'application/json; charset=utf-8'))).status).toBe(200);
    expect(await nicknameOf(player.cookie)).toBe('Bo');
  });

  it('PUT refuses a name outside the pattern (400) or blocked by moderation (422) and keeps the old one', async () => {
    const player = await newPlayer();
    for (const nickname of ['A', 'a'.repeat(21), '<b>hi</b>', 'x/y', 42]) {
      const response = await PUT(put(freshCaller(), player.cookie, { nickname }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe('Use 2–20 letters or numbers.');
    }
    expect((await PUT(put(freshCaller(), player.cookie, 'not json'))).status).toBe(400);
    const blocked = await PUT(put(freshCaller(), player.cookie, { nickname: 'make a bomb' }));
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { error: { message: string } }).error.message).toBe("We can't use that name. Try another one.");
    expect(await nicknameOf(player.cookie)).toBe(player.nickname);
  });

  it(`off Vercel a new x-forwarded-for does not reset the cap of ${NEW_PLAYERS_PER_HOUR} new identities an hour (review T3-1)`, async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-07T20:10:00Z'), toFake: ['Date'] });
    try {
      const players = [];
      for (let i = 0; i < NEW_PLAYERS_PER_HOUR; i++) players.push(await newPlayer());
      const refused = await GET(get(freshCaller()));
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('NEW_PLAYER_QUOTA');
      expect(refused.headers.get('set-cookie')).toBeNull();
      // Hráč, který cookie má, na strop nenarazí.
      expect(await nicknameOf((players[0] as { cookie: string }).cookie)).toBe((players[0] as { nickname: string }).nickname);
      // Další hodina strop obnoví.
      vi.setSystemTime(Date.parse('2026-10-07T21:00:00Z'));
      expect((await GET(get(freshCaller()))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PUT has its own rate window per caller', async () => {
    // Pevný čas: okno stropu je 10 s hodin, smyčka nad souborovým úložištěm by jinak mohla jeho hranici přejít.
    vi.useFakeTimers({ now: Date.parse('2026-10-07T20:10:00.500Z'), toFake: ['Date'] });
    try {
      const player = await newPlayer();
      const caller = freshCaller();
      // `admit` bere slot `play` (50 za okno) dřív než `play/me`; obě okna mají týž strop.
      for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) expect((await PUT(put(caller, player.cookie, { nickname: 'Bo' }))).status).toBe(200);
      expect((await PUT(put(caller, player.cookie, { nickname: 'Bo' }))).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('on Vercel with a secret', () => {
  it(`counts new identities per trusted caller (x-vercel-forwarded-for), ${NEW_PLAYERS_PER_HOUR} an hour`, async () => {
    vi.stubEnv('VERCEL', '1');
    const trusted = (ip: string): Request => new Request(URL_ME, { headers: { 'x-vercel-forwarded-for': ip, 'x-forwarded-for': freshCaller() } });
    for (let i = 0; i < NEW_PLAYERS_PER_HOUR; i++) {
      resetRateWindows();
      expect((await GET(trusted('203.0.113.7'))).status).toBe(200);
    }
    expect((await GET(trusted('203.0.113.7'))).status).toBe(429);
    expect((await GET(trusted('203.0.113.8'))).status).toBe(200);
  });
});

describe('without a usable secret', () => {
  it('on Vercel without PLAY_IDENTITY_SECRET GET and PUT are 503 IDENTITY_UNAVAILABLE and issue nothing', async () => {
    vi.stubEnv('PLAY_IDENTITY_SECRET', '');
    vi.stubEnv('VERCEL', '1');
    const signed = `${PLAYER_COOKIE}=${issuePlayer(SECRET).value}`;
    for (const response of [await GET(get(freshCaller())), await GET(get(freshCaller(), signed)), await PUT(put(freshCaller(), signed, { nickname: 'Ada' }))]) {
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('IDENTITY_UNAVAILABLE');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });
});

describe('restart of the file store', () => {
  it('keeps the chosen name across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p44b-me-'));
    dirs.push(dir);
    vi.stubEnv('PLAY_STORE_DIR', dir);
    const player = await newPlayer();
    expect((await PUT(put(freshCaller(), player.cookie, { nickname: 'Ada' }))).status).toBe(200);
    __resetProcessVersionStore();
    expect(await nicknameOf(player.cookie)).toBe('Ada');
  });
});
