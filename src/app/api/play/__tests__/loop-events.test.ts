/**
 * Události smyčky (P27D T4, B4): uzavřený kontrakt bez vět, dveře, které nic
 * jiného nepřijmou, a trychtýř se skutečnými jmenovateli.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLEAR_RATE_MIN_STARTS, clearRate, type LoopEvent, loopCountersOf, readLoopEvent, summarizeLoop } from '@/play/loop-events';
import { MAX_REQUESTS_PER_WINDOW, MAX_REQUESTS_PER_WINDOW_PER_INSTANCE, resetRateWindows, takeRateSlot } from '@/server/rate-limit';

import { MAX_DAY_BYTES } from '../_events';
import { callerOf } from '../_publish';
import { POST as sendEvent } from '../events/route';

const VERSION = 'a1b2c3d4e5f60718';
const SESSION = 'k3j2h1g0f9e8d7c6';
const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.44' };

describe('readLoopEvent', () => {
  it('takes exactly name, versionId and session', () => {
    expect(readLoopEvent({ name: 'win', versionId: VERSION, session: SESSION })).toEqual({ name: 'win', versionId: VERSION, session: SESSION });
  });

  it.each([
    ['a sentence riding along', { name: 'impression', versionId: VERSION, session: SESSION, sentence: 'a hamster escapes' }],
    ['an unknown name', { name: 'purchase', versionId: VERSION, session: SESSION }],
    ['a version id that is not hex', { name: 'win', versionId: 'hamster-escape', session: SESSION }],
    ['a session with free text', { name: 'win', versionId: VERSION, session: 'john.doe@example.com' }],
    ['an array', [{ name: 'win', versionId: VERSION, session: SESSION }]],
    ['withClip on anything but share', { name: 'win', versionId: VERSION, session: SESSION, withClip: true }],
    ['withClip that is not a boolean', { name: 'share', versionId: VERSION, session: SESSION, withClip: 'yes' }],
    ['dare on anything but share', { name: 'win', versionId: VERSION, session: SESSION, dare: true }],
    ['dare that is not a boolean', { name: 'share', versionId: VERSION, session: SESSION, withClip: false, dare: 'a1b2c3d4' }],
  ])('refuses %s', (_why, body) => {
    expect(readLoopEvent(body)).toBeNull();
  });

  it('a share says whether the clip went with it (P29D T2)', () => {
    expect(readLoopEvent({ name: 'share', versionId: VERSION, session: SESSION, withClip: true })).toEqual({ name: 'share', versionId: VERSION, session: SESSION, withClip: true });
    expect(readLoopEvent({ name: 'share', versionId: VERSION, session: SESSION, withClip: false })).toEqual({ name: 'share', versionId: VERSION, session: SESSION, withClip: false });
  });

  it('a share says whether the link carried a dare (P36B T6)', () => {
    expect(readLoopEvent({ name: 'share', versionId: VERSION, session: SESSION, withClip: false, dare: true })).toStrictEqual({ name: 'share', versionId: VERSION, session: SESSION, withClip: false, dare: true });
    expect(readLoopEvent({ name: 'share', versionId: VERSION, session: SESSION, withClip: true, dare: false })).toStrictEqual({ name: 'share', versionId: VERSION, session: SESSION, withClip: true, dare: false });
  });
});

describe('clear rate (P37C T5)', () => {
  it('an attempt is first_input or a run end, a win counts as a finish and a clear, and nothing else counts', () => {
    const of = (name: LoopEvent['name']) => loopCountersOf({ name, versionId: VERSION, session: SESSION });
    expect(of('first_input')).toEqual(['start']);
    expect(of('win')).toEqual(['start', 'finish', 'clear']);
    expect(of('lose')).toEqual(['start', 'finish']);
    expect(of('next_game')).toEqual(['skip']);
    for (const name of ['impression', 'restart', 'share', 'shared_open'] as const) expect(of(name)).toEqual([]);
  });

  it(`says nothing below ${String(CLEAR_RATE_MIN_STARTS)} attempts, rounds to a whole percent and never goes above 100`, () => {
    expect(clearRate(CLEAR_RATE_MIN_STARTS - 1, 5)).toBeNull();
    expect(clearRate(CLEAR_RATE_MIN_STARTS, 0)).toBe(0);
    expect(clearRate(CLEAR_RATE_MIN_STARTS, 3)).toBe(30);
    expect(clearRate(12, 5)).toBe(42);
    expect(clearRate(10, 40)).toBe(100);
  });
});

describe('summarizeLoop', () => {
  const ev = (name: LoopEvent['name'], session = SESSION, versionId = VERSION): LoopEvent => ({ name, versionId, session });

  it('one session, two games and a link opened elsewhere: each step once, real denominators', () => {
    const other = 'b1b2b3b4b5b6b7b8';
    const friend = 'zzzzyyyyxxxxwwww';
    const report = summarizeLoop([
      ev('impression'),
      ev('impression'), // znovu načtená stránka se nepočítá dvakrát
      ev('first_input'),
      ev('first_input'),
      ev('lose'),
      ev('restart'),
      ev('win'),
      ev('share'),
      ev('next_game'),
      ev('impression', SESSION, other),
      ev('impression', friend),
      ev('shared_open', friend),
      ev('shared_open', friend),
    ]);
    expect(report.sessions).toBe(2);
    expect(report.counts).toMatchObject({ impression: 3, first_input: 1, win: 1, lose: 1, restart: 1, next_game: 1, share: 1, shared_open: 1 });
    expect(report.rates.played).toEqual({ hit: 1, of: 3 });
    expect(report.rates.finished).toEqual({ hit: 2, of: 1 });
    expect(report.rates.restarted).toEqual({ hit: 1, of: 2 });
    expect(report.rates.sharedOpenPerShare).toEqual({ hit: 1, of: 1 });
  });
});

describe('POST /api/play/events', () => {
  let dir = '';

  beforeEach(() => {
    resetRateWindows();
    dir = mkdtempSync(join(tmpdir(), 'play-events-'));
    vi.stubEnv('PLAY_EVENTS_DIR', dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) => sendEvent(new Request('http://play.test/api/play/events', { method: 'POST', headers: CALLER, body: JSON.stringify(body) }));
  const lines = (): Record<string, unknown>[] =>
    readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));

  it('stores the event with a server time and nothing else', async () => {
    expect((await post({ name: 'first_input', versionId: VERSION, session: SESSION })).status).toBe(204);
    const [line] = lines();
    expect(Object.keys(line).sort()).toEqual(['at', 'name', 'session', 'versionId']);
    expect(line).toMatchObject({ name: 'first_input', versionId: VERSION, session: SESSION });
  });

  it('a body carrying the sentence is 400 and writes nothing', async () => {
    const response = await post({ name: 'impression', versionId: VERSION, session: SESSION, sentence: 'A hamster escapes a supermarket' });
    expect(response.status).toBe(400);
    expect(existsAny()).toBe(false);
  });

  it('has its own rate window: a caller out of play slots can still report, and the reverse', async () => {
    const caller = callerOf(new Request('http://play.test/api/play/events', { headers: CALLER }));
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1) takeRateSlot('play', caller);
    expect((await post({ name: 'win', versionId: VERSION, session: SESSION })).status).toBe(204);
    resetRateWindows();
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1) takeRateSlot('play/events', caller);
    expect((await post({ name: 'win', versionId: VERSION, session: SESSION })).status).toBe(429);
    expect(takeRateSlot('play', caller).allowed).toBe(true);
  });

  it('a flood of events from many addresses leaves game creation open, and the events keep their own server cap', () => {
    for (let n = 0; n < MAX_REQUESTS_PER_WINDOW_PER_INSTANCE; n += 1) takeRateSlot('play/events', `198.51.100.${String(n % 250)}#${String(n)}`);
    expect(takeRateSlot('play/events', 'one-more').allowed).toBe(false);
    expect(takeRateSlot('play', 'a-player').allowed).toBe(true);
  });

  it('stops appending once the day file reaches the cap', async () => {
    const day = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(day, 'x'.repeat(MAX_DAY_BYTES));
    expect((await post({ name: 'win', versionId: VERSION, session: SESSION })).status).toBe(204);
    expect(statSync(day).size).toBe(MAX_DAY_BYTES);
  });

  function existsAny(): boolean {
    return readdirSync(dir).length > 0;
  }
});
