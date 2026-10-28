/**
 * Interní `/play/stats` (P44B T13): trychtýř smyčky za 7 a 14 dní z úložiště, za bránou
 * `statsAccess`. Na veřejném demu bez klíče i se špatným klíčem 404 dřív, než se sáhne na
 * úložiště; v HTML nikdy klíč, id hráče, relace ani věta.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { default: StatsPage, dynamic, metadata } = await import('../stats/page');
const { POST: createGame } = await import('@/app/api/play/games/route');
const { STARTERS } = await import('@/components/play/starters');

const KEY = 'test-stats-key-not-a-secret-0001';
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const PLAYER = 'player-id-must-not-show-0123456789';

async function html(search: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await StatsPage({ searchParams: Promise.resolve(search) }));
}

/** Okno stránky podle nadpisu („Last 7 days“ až po další sekci). */
function windowOf(page: string, days: 7 | 14): string {
  const start = page.indexOf(`Last ${String(days)} days`);
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf('<section', start);
  return page.slice(start, end === -1 ? undefined : end);
}

/** Hra ze startovní věty, zařazená do feedu (návrh ze slov tam sám nejde); `put` sám započte stupeň `say`. */
async function seededGame(): Promise<{ id: string; sentence: string; title: string }> {
  const { sentence } = STARTERS[0]!;
  const created = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.31' }, body: JSON.stringify({ sentence }) }));
  const { versionId } = (await created.json()) as { versionId: string };
  const versions = versionStoreFromEnv(process.env);
  const game = (await versions.get(versionId))!;
  await versions.feature(game);
  return { id: versionId, sentence, title: game.version.title };
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.VERCEL;
  delete process.env.PLAY_STATS_KEY;
});

describe('/play/stats', () => {
  it('is never indexed, never cached and never leaks the key as a referrer', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.referrer).toBe('no-referrer');
  });

  it('shows 7 and 14 day counts, adjacent conversion and the strongest game – no ids, no sentence', async () => {
    const { id, sentence, title } = await seededGame();
    const versions = versionStoreFromEnv(process.env);
    vi.setSystemTime(NOW - 10 * DAY);
    await versions.countFunnel('play', id, 'session-old-must-not-show');
    vi.setSystemTime(NOW);
    await versions.countFunnel('say', id, 'session-b-must-not-show');
    await versions.countFunnel('play', id, 'session-a-must-not-show');
    await versions.countFunnel('finish', id, 'session-a-must-not-show');
    await versions.countFunnel('beat', id, PLAYER);
    await versions.countLoop(id, ['dare'], 'voter-1');
    await versions.countLoop(id, ['dare'], 'voter-2');

    const page = await html();
    const week = windowOf(page, 7);
    expect(week).toContain('Say → Play 50%');
    expect(week).toContain('Play → Finish 100%');
    expect(week).toContain('Finish → Share 0%');
    expect(week).toContain('Share → Open –');
    const fortnight = windowOf(page, 14);
    expect(fortnight).toContain('Say → Play 100%');
    expect(fortnight).toContain('Play → Finish 50%');

    expect(page).toContain(`href="/play/${id}"`);
    expect(page).toContain(title);
    expect(page).toContain('2 dares');
    expect(page).not.toContain(PLAYER);
    expect(page).not.toContain('must-not-show');
    expect(page).not.toContain('voter-');
    expect(page).not.toContain(sentence);
  });

  it('says so plainly when nothing has been counted', async () => {
    const page = await html();
    expect(windowOf(page, 7)).toContain('Say → Play –');
    expect(page).toContain('No dares or remixes yet.');
    expect(page).toContain('D1 –');
  });

  // P63 T5: návrat hráče – D1 z dne, jehož 1. den uplynul; id návštěvníka stránka nikdy neukáže.
  it('shows returning players and D1, never a visitor id', async () => {
    const versions = versionStoreFromEnv(process.env);
    const visitor = '6f1c2b9e-3d4a-4f8b-9c1d-2e3f4a5b6c7d';
    vi.setSystemTime(NOW - 2 * DAY);
    await versions.countVisitor(visitor);
    vi.setSystemTime(NOW - DAY);
    await versions.countVisitor(visitor);
    vi.setSystemTime(NOW);
    const page = await html();
    expect(page).toContain('Returning players');
    expect(page).toContain('D1 100% (1 of 1)');
    expect(page).toContain('D7 –');
    expect(page).not.toContain(visitor);
  });

  it('on Vercel without a key: 404 before any store read', async () => {
    process.env.VERCEL = '1';
    const funnel = vi.spyOn(versionStoreFromEnv(process.env), 'funnel');
    await expect(html()).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(html({ key: KEY })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(funnel).not.toHaveBeenCalled();
  });

  it('on Vercel with the key: the table; a wrong key of equal length or one char more: 404', async () => {
    process.env.VERCEL = '1';
    process.env.PLAY_STATS_KEY = KEY;
    const page = await html({ key: KEY });
    expect(page).toContain('Last 14 days');
    expect(page).not.toContain(KEY);
    await expect(html({ key: `${KEY.slice(0, -1)}2` })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(html({ key: `${KEY}x` })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(html({ key: [KEY, KEY] })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
