/**
 * Rezerva pro porotu (P68I T7): do `PLAY_JUDGING_FROM` smí veřejný provoz utratit jen `strop − PLAY_JUDGING_RESERVE_USD`,
 * od toho data celý strop. Bez proměnných beze změny. Hodiny serveru, ne hashovaný stav hry.
 */

import { describe, expect, it } from 'vitest';

import { SpendCap, judgingReserveFromEnv, spendCapFromEnv } from '../spend-cap';

const FROM = Date.parse('2026-11-08T09:00:00Z');
const BEFORE = FROM - 60_000;
const AFTER = FROM + 60_000;
const ENV = { WORLDSMITH_SPEND_CAP_USD: '10', PLAY_JUDGING_FROM: '2026-11-08T09:00:00Z', PLAY_JUDGING_RESERVE_USD: '4' };

/** Strop 10 USD s rezervou 4 USD z prostředí a hodinami nastavenými na `at`. */
const capAt = (at: number, env: Record<string, string> = ENV): SpendCap =>
  new SpendCap({ enabled: true, capUsd: Number(env.WORLDSMITH_SPEND_CAP_USD) }, null, undefined, null, judgingReserveFromEnv(env, () => at));

describe('judging reserve', () => {
  it('holds the reserve before the judging date: public traffic gets only cap − reserve', async () => {
    const cap = capAt(BEFORE);
    expect((await cap.reserve(6.5)).ok).toBe(false);
    expect((await cap.reserve(6)).ok).toBe(true);
    expect(await cap.exhausted()).toBe(true);
    expect(cap.snapshot().capUsd).toBe(6);
  });

  it('releases the whole cap from the judging date on', async () => {
    const cap = capAt(AFTER);
    expect((await cap.reserve(10)).ok).toBe(true);
    expect(cap.snapshot().capUsd).toBe(10);
  });

  it('a long-lived process crosses the date: the same cap opens without a restart', async () => {
    let now = BEFORE;
    const cap = new SpendCap({ enabled: true, capUsd: 10 }, null, undefined, null, judgingReserveFromEnv(ENV, () => now));
    expect((await cap.reserve(6)).ok).toBe(true);
    expect((await cap.reserve(1)).ok).toBe(false);
    now = AFTER;
    expect((await cap.reserve(4)).ok).toBe(true);
  });

  it('is exactly at the reserve: spending up to cap − reserve passes, one cent more does not', async () => {
    const cap = capAt(BEFORE);
    expect((await cap.reserve(5.99)).ok).toBe(true);
    expect((await cap.reserve(0.01)).ok).toBe(true);
    expect((await cap.reserve(0.01)).ok).toBe(false);
  });

  it('without the variables nothing changes', async () => {
    expect(judgingReserveFromEnv({ WORLDSMITH_SPEND_CAP_USD: '10' }, () => BEFORE)).toBeNull();
    expect(judgingReserveFromEnv({ PLAY_JUDGING_FROM: '2026-11-08T09:00:00Z' }, () => BEFORE)).toBeNull();
    const cap = capAt(BEFORE, { WORLDSMITH_SPEND_CAP_USD: '10' });
    expect((await cap.reserve(10)).ok).toBe(true);
    expect(spendCapFromEnv({ WORLDSMITH_SPEND_CAP_USD: '10' }).snapshot().capUsd).toBe(10);
  });

  it('a typo in either variable holds the whole cap for the jury, never releases it silently', async () => {
    for (const env of [
      { ...ENV, PLAY_JUDGING_FROM: '8. 11.' },
      { ...ENV, PLAY_JUDGING_RESERVE_USD: 'four' },
    ]) {
      const cap = capAt(AFTER, env);
      expect((await cap.reserve(0.01)).ok).toBe(false);
    }
  });

  it('spendCapFromEnv wires the reserve from the environment', () => {
    expect(spendCapFromEnv(ENV, () => BEFORE).snapshot().capUsd).toBe(6);
    expect(spendCapFromEnv(ENV, () => AFTER).snapshot().capUsd).toBe(10);
  });
});
