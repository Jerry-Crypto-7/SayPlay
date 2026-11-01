/**
 * P68I R1: hra P68, kterou ještě žádná úloha „zapoj X“ nezapojila, se na produkci nepublikuje ani ručním specem
 * (`POST /api/play/games`, tělo `spec` remixu – obojí jde přes `readSpecOrFail`). Zapojený žánr projde jako dřív
 * a mimo produkci projde i P68 spec (e2e a testy kategorií publikují své ruční specy touto cestou).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTE_PENDING } from '@/play/genre/classify';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { readSpecOrFail } from '../_publish';
import { POST as createGame } from '../games/route';

const ARROWS = JSON.parse(readFileSync(join(process.cwd(), 'e2e', 'fixtures', 'p66-arrows-spec.json'), 'utf8')) as Record<string, unknown> & { genre: Record<string, unknown> };
/** Spec P68 hry, který `readGameSpec` přijme: šipky s ovládáním a žánrem nezapojené hry. */
const asP68 = (id: string, part: 'control' | 'genre' | 'both') => ({
  ...ARROWS,
  ...(part !== 'genre' ? { control: id } : {}),
  ...(part !== 'control' ? { genre: { ...ARROWS.genre, id } } : {}),
});

const publish = (spec: unknown) =>
  createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.81' }, body: JSON.stringify({ spec }) }));

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('raw-spec publish of an unwired P68 game (R1)', () => {
  it('refuses it in production, by control or by genre', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect([...ROUTE_PENDING]).toContain('stunt');
    for (const part of ['control', 'genre', 'both'] as const) {
      const read = readSpecOrFail(asP68('stunt', part));
      expect(read.ok, part).toBe(false);
      if (!read.ok) expect(read.response.status).toBe(422);
    }
    const response = await publish(asP68('railfps', 'both'));
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('not live yet');
  });

  it('publishes a wired genre in production as before', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const response = await publish(ARROWS);
    expect(response.status, await response.clone().text()).toBe(201);
  });

  it('reads a P68 spec outside production, where e2e and category tests publish their hand specs', () => {
    vi.stubEnv('VERCEL_ENV', '');
    expect(readSpecOrFail(asP68('stunt', 'both')).ok).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(readSpecOrFail(asP68('stunt', 'both')).ok).toBe(true);
  });
});
