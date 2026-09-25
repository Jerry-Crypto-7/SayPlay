/**
 * Poctivá hláška na dveřích (P25E T2): věta, kterou knihovna ovládání neumí,
 * se publikuje dál, ale odpověď nese `honesty`; věta, kterou umíme, ho nemá.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { POST as createGame } from '../games/route';

async function publish(sentence: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await createGame(
    new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ sentence }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/play/games – honesty', () => {
  it('publishes a match-3 sentence and says it is only the closest game', async () => {
    const created = await publish('a match 3 game with fruits');
    expect(created.status).toBe(201);
    expect(created.body.url).toMatch(/^\/play\/[a-f0-9]+$/);
    expect(created.body.honesty).toEqual({
      reason: 'Swapping, sorting and sliding pieces around is not something we can build yet.',
      closest: 'an endless runner',
    });
  });

  it('leaves a runner sentence without honesty', async () => {
    const created = await publish('endless runner in a neon city');
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('honesty');
  });
});
