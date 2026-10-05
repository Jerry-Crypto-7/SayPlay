import { describe, expect, it } from 'vitest';

import { gameName, SHARE_TEXT_MAX, type ShareRun, shareText } from '../share-text';

/**
 * Sdílený výsledek (P37C T4): text vypadá dobře, i když lže – „Can you beat
 * 0?“ nebo hvězdy po prohře čtenář nepozná jako chybu. Proto se tvar pro
 * výhru, prohru a přežití bez bodů píše celý a délka se počítá.
 */

const URL = `https://sayplay.example/play/${'a'.repeat(64)}?via=share&dare=${'b'.repeat(32)}`;

const run = (over: Partial<ShareRun>): ShareRun => ({
  won: true,
  survive: false,
  seconds: 31,
  stars: null,
  score: null,
  lives: null,
  goal: null,
  ...over,
});

describe('shareText', () => {
  it('a scored win names the game, shows stars and lives, and dares the score', () => {
    expect(shareText(run({ stars: 2, score: 2450, lives: 3 }), 'Frog dodge', URL)).toBe(
      ['Frog dodge – sayplay', '⭐⭐☆ ❤️❤️❤️', '⏱️ 31.0s', 'Can you beat 2,450?', URL].join('\n'),
    );
  });

  it('a timed win without points dares the time', () => {
    expect(shareText(run({ stars: 3, goal: { count: 5, need: 5 } }), 'Mushrooms', URL)).toBe(
      ['Mushrooms – sayplay', '⭐⭐⭐ 🟩🟩🟩🟩🟩', '⏱️ 31.0s', 'Can you beat 31.0s?', URL].join('\n'),
    );
  });

  it('a survival win without points dares to survive, not a number', () => {
    expect(shareText(run({ survive: true, seconds: 45, lives: 1 }), 'Lava floor', URL)).toBe(
      ['Lava floor – sayplay', '❤️', '⏱️ 45.0s', 'Can you survive it too?', URL].join('\n'),
    );
  });

  it('a loss shows no stars, only how far it got, and dares without a number', () => {
    const text = shareText(run({ won: false, stars: 2, score: 900, lives: 0, goal: { count: 3, need: 5 } }), 'Mushrooms', URL);
    expect(text).toBe(['Mushrooms – sayplay', '🟩🟩🟩⬜⬜', '⏱️ 31.0s', 'So close. Can you beat it?', URL].join('\n'));
  });

  it('a run with nothing to grid still says how it ended', () => {
    expect(shareText(run({}), null, URL).split('\n').slice(0, 2)).toEqual(['sayplay', '✅']);
    expect(shareText(run({ won: false }), null, URL).split('\n')[1]).toBe('❌');
  });

  it('many goals fit into ten cells and many lives into a number', () => {
    expect(shareText(run({ won: false, goal: { count: 15, need: 40 }, lives: 7 }), null, URL).split('\n')[1]).toBe(`❤️×7 ${'🟩'.repeat(4)}${'⬜'.repeat(6)}`);
  });

  it('without a url there is no link line, for the share sheet that takes the link apart', () => {
    expect(shareText(run({ score: 10 }), 'Frog dodge', null).split('\n')).toEqual(['Frog dodge – sayplay', '✅', '⏱️ 31.0s', 'Can you beat 10?']);
  });

  it('never runs past 280 characters: a long title is cut, the dare and the link stay whole', () => {
    const long = 'A very long game title that keeps going and going and going past every limit';
    for (const over of [{ stars: 3 as const, score: 1_234_567, lives: 9, goal: { count: 9, need: 99 } }, { won: false, goal: { count: 1, need: 12 } }, { survive: true }]) {
      const text = shareText(run(over), long, URL);
      expect(text.length).toBeLessThanOrEqual(SHARE_TEXT_MAX);
      expect(text.endsWith(URL)).toBe(true);
      expect(text.split('\n')[0]).toMatch(/^A very long game title.*… – sayplay$/);
    }
    // Odkaz, který sám zabere skoro všechno: název ustoupí celý.
    const huge = `https://sayplay.example/${'x'.repeat(220)}`;
    const text = shareText(run({ score: 5 }), long, huge);
    expect(text.length).toBeLessThanOrEqual(SHARE_TEXT_MAX);
    expect(text.split('\n')[0]).toBe('sayplay');
  });
});

describe('gameName', () => {
  it('reads the game out of the /play/<id> page title and nothing else', () => {
    expect(gameName('Frog dodge – sayplay')).toBe('Frog dodge');
    expect(gameName('sayplay')).toBeNull();
    expect(gameName('')).toBeNull();
  });
});
