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
});
