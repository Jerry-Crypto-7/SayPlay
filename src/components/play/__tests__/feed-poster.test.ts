/**
 * Feed nečeká sám na prohru (P33 T8). Hra ve feedu se dřív rozběhla bez
 * hráče a za 2,7 s ukázala „You lost“ – první dojem produktu. Teď místo hry
 * stojí plakát s „Tap to play“ a hra se připojí až po klepnutí. Karty feedu
 * říkají cíl hry, ne větu mechaniky, která byla u všech stejná.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('../arcade/ArcadePlay', () => ({ ArcadePlay: () => null }));
vi.mock('../arcade/look/play-env', () => ({ WithPlayEnv: ({ children }: { children: unknown }) => children }));

const { Feed, moodTone } = await import('../Feed');
const { TapToPlay } = await import('../FeedPager');
const { beatFor } = await import('../PostRun');

function Game() {
  return createElement('canvas', { 'data-testid': 'mounted-game' });
}

describe('the feed poster', () => {
  it('does not mount the game before the tap', () => {
    const html = renderToStaticMarkup(createElement(TapToPlay, { title: 'Fox Steals Eggs', goal: 'Collect 5 eggs, then reach the exit.', mood: 'calm', children: createElement(Game) }));
    expect(html).not.toContain('mounted-game');
    expect(html).toContain('Tap to play');
    expect(html).toContain('Collect 5 eggs');
    expect(html).toContain('data-testid="feed-poster"');
  });

  it('colours the scene by mood, never purple, with a neutral fallback', () => {
    expect(moodTone('spooky night')).toBe('dark');
    expect(moodTone('cheerful and sunny')).toBe('warm');
    expect(moodTone('tense chase')).toBe('danger');
    expect(moodTone('calm')).toBe('calm');
    expect(moodTone('whatever')).toBe('calm');
  });
});

describe('feed cards', () => {
  const games = [
    { versionId: 'a', title: 'Penguin Slide', archetype: 'hazard_cross', remixes: 0 },
    { versionId: 'b', title: 'Fire Rescue', archetype: 'hazard_cross', remixes: 1 },
  ];

  it('say the goal of the game instead of the shared mechanic sentence, and hide zero remixes', () => {
    const known = new Map([['a', { goal: 'Slide to the fish.', mood: 'cheerful' }]]);
    const html = renderToStaticMarkup(createElement(Feed, { games, current: 'a', known, onPick: () => {} }));
    expect(html).not.toContain('pulsing hazards');
    expect(html).toContain('Slide to the fish.');
    expect(html).not.toContain('0 remixes');
    expect(html).toContain('1 remix');
    expect(html).toContain('data-tone="warm"');
  });

  it('say "N% beat this" only for a game with a clear rate (P37C T5)', () => {
    const rated = [
      { ...games[0], beat: 42 },
      { ...games[1], beat: null },
    ];
    const html = renderToStaticMarkup(createElement(Feed, { games: rated, current: 'a', known: new Map(), onPick: () => {} }));
    expect(html.match(/data-testid="play-feed-beat"/g)).toHaveLength(1);
    expect(html).toContain('42% beat this');
    expect(renderToStaticMarkup(createElement(Feed, { games, current: 'a', known: new Map(), onPick: () => {} }))).not.toContain('beat this');
  });

  it('the poster says the clear rate only when there is one', () => {
    const poster = (beat: number | null) => renderToStaticMarkup(createElement(TapToPlay, { title: 'Fox', goal: 'Collect 5 eggs.', mood: 'calm', beat, children: createElement(Game) }));
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
