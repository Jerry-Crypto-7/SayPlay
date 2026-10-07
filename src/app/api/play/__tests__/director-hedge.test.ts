/**
 * Záloha zamrzlého režiséra (P29B T8). Předplatné umí viset 285–317 s; po
 * `PLAY_DIRECTOR_HEDGE_MS` bez odpovědi se souběžně pustí lokální model
 * a první platná odpověď vyhraje, druhá se zruší. Strop utrácení a denní
 * kvóta volajícího patří jen primáru – lokální model je zdarma. Falešné hodiny,
 * podvržený `fetch`, nikam se nevolá.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { genreAnswer } from '@/play/director/__fixtures__';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import type { GenerationOutcome } from '@/server/pipeline';
import { resetRateWindows } from '@/server/rate-limit';
import { processSpendCap, resetProcessSpendCap } from '@/server/spend-cap';

import { resetConcurrency } from '../../worldstream/sessions/route';
import { DEFAULT_HEDGE_MS, getDirector, hedged } from '../_director';

const SENTENCE = 'a penguin jumps';

const LIVE = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_USD_PER_MTOK_OUT: '15',
  WORLDSMITH_SPEND_CAP_USD: '5',
  WORLDSMITH_FALLBACK_ENDPOINT: 'llamacpp:http://127.0.0.1:8792',
  WORLDSMITH_FALLBACK_MODEL: 'gpt-oss-20b',
  PLAY_DIRECTOR_HEDGE_MS: '30000',
};

const COMPACT = genreAnswer({ genre: 'platformer', mode: 'default', hero: 'penguin', cast: undefined, setting: 'frozen iceberg field', palette: 'snow' });

const ok = (model: string): GenerationOutcome => ({ ok: true, body: { model }, usage: null, provenance: { model } });
const down: GenerationOutcome = { ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: 'down', usage: null };

/** Volání, které odpoví až na pokyn a pozná zrušení. */
function pending() {
  let answer: (outcome: GenerationOutcome) => void = () => undefined;
  let signal: AbortSignal | null = null;
  const call = vi.fn((s: AbortSignal) => {
    signal = s;
    return new Promise<GenerationOutcome>((resolve) => {
      answer = resolve;
      s.addEventListener('abort', () => resolve({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: 'aborted', usage: null }));
    });
  });
  return { call, answer: (o: GenerationOutcome) => answer(o), aborted: () => signal?.aborted === true };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  __resetProcessVersionStore();
  resetRateWindows();
  resetConcurrency();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetProcessSpendCap();
  resetConcurrency();
});

describe('hedged', () => {
  it('never starts the fallback when the primary answers within the hedge', async () => {
    const primary = pending();
    const fallback = pending();
    const result = hedged(primary.call, fallback.call, 30_000);
    await vi.advanceTimersByTimeAsync(29_000);
    primary.answer(ok('astra'));
    await expect(result).resolves.toMatchObject({ ok: true, provenance: { model: 'astra' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fallback.call).not.toHaveBeenCalled();
  });

  it('starts the fallback at the hedge, takes its answer and cancels the primary', async () => {
    const primary = pending();
    const fallback = pending();
    const result = hedged(primary.call, fallback.call, 30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fallback.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback.call).toHaveBeenCalledTimes(1);
    fallback.answer(ok('gpt-oss-20b'));
    await expect(result).resolves.toMatchObject({ ok: true, provenance: { model: 'gpt-oss-20b' } });
    expect(primary.aborted()).toBe(true);
    expect(fallback.aborted()).toBe(false);
  });

  it('cancels the fallback when the primary wins after the hedge', async () => {
    const primary = pending();
    const fallback = pending();
    const result = hedged(primary.call, fallback.call, 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    primary.answer(ok('astra'));
    await expect(result).resolves.toMatchObject({ ok: true, provenance: { model: 'astra' } });
    expect(fallback.aborted()).toBe(true);
    expect(primary.aborted()).toBe(false);
  });

  it('starts the fallback at once when the primary fails early', async () => {
    const fallback = pending();
    const result = hedged(() => Promise.resolve(down), fallback.call, 30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback.call).toHaveBeenCalledTimes(1);
    fallback.answer(ok('gpt-oss-20b'));
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it("returns the primary's failure when both fail", async () => {
    const malformed: GenerationOutcome = { ok: false, reason: 'MALFORMED_RESPONSE', detail: 'bad', usage: null };
    const result = hedged(() => Promise.resolve(malformed), () => Promise.resolve(down), 30_000);
    await expect(result).resolves.toBe(malformed);
  });

  it('treats a thrown call as a failure', async () => {
    const result = hedged(() => Promise.reject(new Error('boom')), () => Promise.resolve(ok('gpt-oss-20b')), 30_000);
    await expect(result).resolves.toMatchObject({ ok: true, provenance: { model: 'gpt-oss-20b' } });
  });

  it('is the plain primary without a fallback', async () => {
    const primary = pending();
    const result = hedged(primary.call, null, 30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    primary.answer(down);
    await expect(result).resolves.toBe(down);
  });

  it('defaults to 30 s', () => {
    expect(DEFAULT_HEDGE_MS).toBe(30_000);
  });
});

describe('getDirector with a local fallback', () => {
  function stubEnv(env: Record<string, string>): void {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    resetProcessSpendCap();
  }

  /** Primár visí do zrušení; záloha odpoví platnou kompaktní odpovědí. */
  function stubFetch() {
    const seen = { primary: 0, fallback: 0, primaryAborted: false };
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1:8792')) {
        seen.fallback += 1;
        return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(COMPACT) }, finish_reason: 'stop' }] }));
      }
      seen.primary += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          seen.primaryAborted = true;
          reject(new Error('aborted'));
        });
      });
    });
    return seen;
  }

  it('a stalled subscription call ends with the local answer and authoredBy', async () => {
    stubEnv(LIVE);
    const seen = stubFetch();
    const game = getDirector(Date.now(), 'hedge-caller')(SENTENCE);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await game;
    expect(result.source).toBe('authored');
    expect(result.authoredBy).toBe('gpt-oss-20b');
    expect(seen).toEqual({ primary: 1, fallback: 1, primaryAborted: true });
  });

  it('counts only the primary against the caller quota and the call cap', async () => {
    stubEnv({ ...LIVE, PLAY_DIRECTOR_CALLS_PER_CALLER: '1' });
    stubFetch();
    const game = getDirector(Date.now(), 'hedge-quota')(SENTENCE);
    await vi.advanceTimersByTimeAsync(30_000);
    await game;
    // Kvóta 1 je spotřebovaná primárem; záloha si žádné volání nevzala.
    await expect(versionStoreFromEnv(process.env).takeDirectorCall('hedge-quota', 2)).resolves.toBe(true);
    await expect(versionStoreFromEnv(process.env).takeDirectorCall('hedge-quota', 2)).resolves.toBe(false);
    // Strop vidí jediné volání (primár) a nic v knize nevisí.
    expect(processSpendCap().snapshot()).toMatchObject({ callsMade: 1, reservedUsd: 0 });
  });

  it('settles the cancelled primary before the director returns (R1)', async () => {
    stubEnv(LIVE);
    // Primár po zrušení doběhne až za sekundu – jako codex, který se zabíjí.
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1:8792'))
        return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(COMPACT) }, finish_reason: 'stop' }] }));
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 1000));
      });
    });
    const heldAtReturn = getDirector(Date.now(), 'hedge-settle')(SENTENCE).then(() => processSpendCap().snapshot().reservedUsd);
    await vi.advanceTimersByTimeAsync(32_000);
    await expect(heldAtReturn).resolves.toBe(0);
  });

  it('PLAY_DIRECTOR_HEDGE_MS moves the moment the fallback starts', async () => {
    stubEnv({ ...LIVE, PLAY_DIRECTOR_HEDGE_MS: '5000' });
    const seen = stubFetch();
    const game = getDirector(Date.now(), 'hedge-env')(SENTENCE);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(seen.fallback).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.fallback).toBe(1);
    expect((await game).authoredBy).toBe('gpt-oss-20b');
  });

  it('without WORLDSMITH_FALLBACK_ENDPOINT the stalled call just waits', async () => {
    const { WORLDSMITH_FALLBACK_ENDPOINT: _drop, ...primaryOnly } = LIVE;
    stubEnv(primaryOnly);
    const seen = stubFetch();
    void getDirector(Date.now(), 'hedge-none')(SENTENCE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.fallback).toBe(0);
    expect(seen.primaryAborted).toBe(false);
  });
});
