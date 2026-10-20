/**
 * Feed nečeká sám na prohru (P33 T8). Hra ve feedu se dřív rozběhla bez
 * hráče a za 2,7 s ukázala „You lost“ – první dojem produktu. Od P54A T7 hraje
 * na kartě náhled robota (ten neprohrává) s nápovědou „Tap to play“ a ťuk hru
 * převezme. Cíl hry říká nápověda karty; „Up next“ (T12) ukazuje další karty obrázkem.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('../arcade/ArcadePlay', () => ({ ArcadePlay: () => null }));
vi.mock('../arcade/look/play-env', () => ({ WithPlayEnv: ({ children }: { children: unknown }) => children }));

const { Feed, moodTone } = await import('../Feed');
const { TapHint } = await import('../feed/ReelCard');
const { beatFor } = await import('../PostRun');

describe('the feed poster', () => {
  // P54A T7: nad náhledem robota stojí jen nápověda – ťuk musí projít na scénu, kde hru převezme.
  it('says "Tap to play" over the bot preview without catching the tap', () => {
    const html = renderToStaticMarkup(createElement(TapHint, { goal: 'Collect 5 eggs, then reach the exit.', beat: 37 }));
    expect(html).toContain('Tap to play');
    expect(html).toContain('Collect 5 eggs');
    expect(html).toContain('37% beat this');
    expect(html).not.toContain('<button');
    expect(html).toContain('aria-hidden="true"');
  });

  it('colours the scene by mood, never purple, with a neutral fallback', () => {
    expect(moodTone('spooky night')).toBe('dark');
    expect(moodTone('cheerful and sunny')).toBe('warm');
    expect(moodTone('tense chase')).toBe('danger');
    expect(moodTone('calm')).toBe('calm');
    expect(moodTone('whatever')).toBe('calm');
  });
});

describe('up next (P54A T12)', () => {
  const games = [
    { versionId: 'a', title: 'Penguin Slide', archetype: 'hazard_cross', remixes: 0 },
    { versionId: 'b', title: 'Fire Rescue', archetype: 'hazard_cross', remixes: 1 },
    { versionId: 'c', title: 'Egg Hunt', archetype: 'collect', remixes: 0 },
    { versionId: 'd', title: 'Rooftop Run', archetype: 'runner', remixes: 0 },
    { versionId: 'e', title: 'Pipe Flap', archetype: 'flap', remixes: 0 },
  ];
  const upNext = (index: number, more: Partial<Parameters<typeof Feed>[0]> = {}) =>
    renderToStaticMarkup(createElement(Feed, { games, index, known: new Map(), shot: () => undefined, onPick: () => {}, ...more }));

  it('shows the three cards after the current one as pictures, toned by mood, and hides zero remixes', () => {
    const html = upNext(0, { known: new Map([['b', { goal: 'Put out the fire.', mood: 'cheerful' }]]), shot: (id) => (id === 'c' ? 'blob:shot-c' : undefined) });
    expect(html.match(/data-testid="play-feed-card"/g)).toHaveLength(3);
    expect(html).not.toContain('Penguin Slide');
    expect(html).not.toContain('Pipe Flap');
    expect(html).toContain('Up next');
    expect(html).toContain('1 remix');
    expect(html).not.toContain('0 remixes');
    expect(html).toContain('data-tone="warm"');
    expect(html).toContain('src="blob:shot-c"');
    expect(html).toContain('src="/api/play/games/d/og"');
  });

  it('shows what is left at the end of the feed and nothing after the last card', () => {
    expect(upNext(3).match(/data-testid="play-feed-card"/g)).toHaveLength(1);
    expect(upNext(4)).toBe('');
  });

  it('says "N% beat this" only for a game with a clear rate (P37C T5)', () => {
    const rated = [games[0], { ...games[1], beat: 42 }, { ...games[2], beat: null }];
    const html = upNext(0, { games: rated });
    expect(html.match(/data-testid="play-feed-beat"/g)).toHaveLength(1);
    expect(html).toContain('42% beat this');
    expect(upNext(0)).not.toContain('beat this');
  });

  it('the poster says the clear rate only when there is one', () => {
    const poster = (beat: number | null) => renderToStaticMarkup(createElement(TapHint, { goal: 'Collect 5 eggs.', beat }));
    expect(poster(0)).toContain('0% beat this');
    expect(poster(null)).not.toContain('beat this');
  });
});

describe('the clear rate on the result (P37C T5)', () => {
  const answer = (status: number, body: unknown): typeof fetch => vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

  it('reads beat from the game, once per version, and refuses anything that is not a whole percent', async () => {
    const fetcher = answer(200, { beat: 42 });
    expect(await beatFor('c'.repeat(32), fetcher)).toBe(42);
    expect(await beatFor('c'.repeat(32), fetcher)).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const [n, beat] of [null, '42', 4.5, -1, 101].entries()) expect(await beatFor(String(n).repeat(32), answer(200, { beat }))).toBeNull();
    expect(await beatFor('d'.repeat(32), answer(404, { beat: 42 }))).toBeNull();
    expect(await beatFor('e'.repeat(32), () => Promise.reject(new Error('offline')))).toBeNull();
  });

  it('remembers an answer, not a passing failure: after a 429 or a network error the next result asks again', async () => {
    for (const [id, failing] of [
      ['f'.repeat(32), answer(429, {})],
      ['a'.repeat(32), () => Promise.reject(new Error('offline'))],
    ] as const) {
      expect(await beatFor(id, failing)).toBeNull();
      expect(await beatFor(id, answer(200, { beat: 7 }))).toBe(7);
    }
    const gone = answer(404, {});
    await beatFor('b'.repeat(32), gone);
    await beatFor('b'.repeat(32), gone);
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
