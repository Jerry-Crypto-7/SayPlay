import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLAYER_COOKIE, identitySecret, issuePlayer, playerCookie, playerOf } from '../player-identity';

const SECRET = 'FIXTURE_ONLY_NOT_A_REAL_SECRET_0000000000';
const OTHER = 'FIXTURE_ONLY_OTHER_FAKE_SECRET_1111111111';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p44b-identity-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const withCookie = (cookie: string): Request => new Request('http://fixture.invalid/api/play/me', { headers: { cookie } });

describe('issuePlayer and playerOf', () => {
  const env = { PLAY_IDENTITY_SECRET: SECRET };

  it('issues a 128-bit base64url id signed with HMAC-SHA256 over "sp1:" + id', () => {
    const { id, value } = issuePlayer(SECRET);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(id, 'base64url')).toHaveLength(16);
    expect(value).toBe(`${id}.${createHmac('sha256', SECRET).update(`sp1:${id}`).digest('base64url')}`);
    expect(issuePlayer(SECRET).id).not.toBe(id);
  });

  it.each(['production', 'test'])('a valid cookie gives back the same id (NODE_ENV=%s)', (nodeEnv) => {
    const { id, value } = issuePlayer(SECRET);
    expect(playerOf(withCookie(`other=1; ${PLAYER_COOKIE}=${value}; theme=dark`), { ...env, NODE_ENV: nodeEnv })).toBe(id);
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${value}`), { ...env, NODE_ENV: nodeEnv, VERCEL: '1' })).toBe(id);
  });

  it('refuses each of the five forgeries', () => {
    const { id, value } = issuePlayer(SECRET);
    const signature = value.slice(id.length + 1);
    const otherId = issuePlayer(SECRET).id;
    const forgeries = [
      issuePlayer(OTHER).value, // signed with another secret
      `${otherId}.${signature}`, // changed id under a real signature
      `${id}${signature}`, // missing dot
      `${value}${'A'.repeat(201 - value.length)}`, // over 200 characters
    ];
    for (const forged of forgeries) expect(playerOf(withCookie(`${PLAYER_COOKIE}=${forged}`), env)).toBeNull();
    // Duplicate cookie – even when both copies are valid.
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${value}; ${PLAYER_COOKIE}=${value}`), env)).toBeNull();
  });

  it('refuses a missing cookie, an empty value and a truncated signature', () => {
    const { value } = issuePlayer(SECRET);
    expect(playerOf(new Request('http://fixture.invalid'), env)).toBeNull();
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=`), env)).toBeNull();
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${value.slice(0, -1)}`), env)).toBeNull();
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=.${value.split('.')[1]}`), env)).toBeNull();
  });

  it('on Vercel without a secret identity is off: a cookie signed with any secret is refused', () => {
    const forged = issuePlayer(SECRET).value;
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${forged}`), { VERCEL: '1', NODE_ENV: 'production' })).toBeNull();
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${forged}`), { VERCEL: '1', NODE_ENV: 'production', PLAY_IDENTITY_SECRET: '' })).toBeNull();
  });
});

describe('identitySecret', () => {
  it('takes PLAY_IDENTITY_SECRET of at least 32 characters, with and without VERCEL', () => {
    expect(identitySecret({ PLAY_IDENTITY_SECRET: SECRET })).toBe(SECRET);
    expect(identitySecret({ PLAY_IDENTITY_SECRET: SECRET, VERCEL: '1', NODE_ENV: 'production' })).toBe(SECRET);
  });

  it('refuses a shorter secret with a warning that does not carry it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const short = 'FAKE_SHORT_SECRET_31_CHARACTERS';
    expect(short).toHaveLength(31);
    expect(identitySecret({ PLAY_IDENTITY_SECRET: short })).toBeNull();
    expect(identitySecret({ PLAY_IDENTITY_SECRET: short, VERCEL: '1' })).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain(short);
  });

  it('on Vercel without a secret returns null (identity off)', () => {
    expect(identitySecret({ VERCEL: '1', NODE_ENV: 'production' })).toBeNull();
    expect(identitySecret({ VERCEL: '1', NODE_ENV: 'production', PLAY_STORE_DIR: tempDir() })).toBeNull();
  });

  it('outside Vercel creates identity-secret beside the file store and reuses it', () => {
    const dir = tempDir();
    const log = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined), vi.spyOn(console, 'info').mockImplementation(() => undefined)];
    const secret = identitySecret({ PLAY_STORE_DIR: dir, NODE_ENV: 'production' });
    expect(secret).not.toBeNull();
    expect(secret!.length).toBeGreaterThanOrEqual(32);
    const path = join(dir, 'identity-secret');
    expect(readFileSync(path, 'utf8')).toBe(secret);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(identitySecret({ PLAY_STORE_DIR: dir, NODE_ENV: 'test' })).toBe(secret);
    for (const spy of log) expect(spy.mock.calls.flat().join(' ')).not.toContain(secret!);
  });

  it('reuses a secret file written before this process started (restart)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'identity-secret'), OTHER);
    expect(identitySecret({ PLAY_STORE_DIR: dir })).toBe(OTHER);
    const { id, value } = issuePlayer(OTHER);
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${value}`), { PLAY_STORE_DIR: dir })).toBe(id);
  });

  it('outside Vercel without a writable store dir keeps one random secret for the process', () => {
    const env = { VITEST: '1', NODE_ENV: 'test' };
    const secret = identitySecret(env);
    expect(secret).not.toBeNull();
    expect(secret!.length).toBeGreaterThanOrEqual(32);
    expect(identitySecret(env)).toBe(secret);
    const { id, value } = issuePlayer(secret!);
    expect(playerOf(withCookie(`${PLAYER_COOKIE}=${value}`), env)).toBe(id);
  });
});

describe('playerCookie', () => {
  const { value } = issuePlayer(SECRET);

  it('carries HttpOnly, SameSite=Lax, Path=/ and a 400-day Max-Age', () => {
    const cookie = playerCookie(value, new Request('http://127.0.0.1:3217/api/play/me'));
    expect(cookie.startsWith(`${PLAYER_COOKIE}=${value};`)).toBe(true);
    const flags = cookie.split(';').map((part) => part.trim());
    expect(flags).toContain('HttpOnly');
    expect(flags).toContain('SameSite=Lax');
    expect(flags).toContain('Path=/');
    expect(flags).toContain('Max-Age=34560000');
    expect(flags).not.toContain('Secure');
  });

  it('adds Secure only for https', () => {
    expect(playerCookie(value, new Request('https://sayplay.example/api/play/me')).split(';').map((part) => part.trim())).toContain('Secure');
  });
});
