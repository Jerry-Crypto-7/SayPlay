/**
 * Výběr panoramatu z věty (P29C T4). Špatné pozadí vypadá pořád jako pozadí,
 * takže oko chybu nepozná – pin je na štítky vybraného panoramatu a na podíl
 * vět korpusu, kterým pozadí ukáže slovo prostředí.
 */

import { describe, expect, it } from 'vitest';

import coverage from '../../../../../evals/play/env/coverage.json';
import catalog from '../env-catalog.json';
import { envFor } from '../env';
import { lookOf } from '../index';

const theme = (setting: string, mood = '') => ({ setting, mood });

describe('envFor', () => {
  it('takes the panorama that carries every word of the setting, not just one', () => {
    const env = envFor(theme('in a snowy forest'), 1);
    expect(env.tags).toEqual(expect.arrayContaining(['snow', 'forest']));
  });

  it('prefers a specific setting over the look it falls into', () => {
    expect(envFor(theme('a haunted castle'), 1).tags).toEqual(expect.arrayContaining(['haunted', 'castle']));
    expect(envFor(theme('on the lily pads of a pond'), 1).id).toBe('set-pond');
  });

  it('falls back to a variant of the look for an unknown setting', () => {
    const unknown = theme('somewhere nobody has named', 'spooky');
    const env = envFor(unknown, 7);
    expect(env.look).toBe(lookOf(unknown));
  });

  it('honours the look the model chose when no tag matches', () => {
    const env = envFor({ setting: 'a quiet place', mood: '', look: 'space' }, 2);
    expect(env.look).toBe('space');
  });

  it('is deterministic for a seed and spreads over variants across seeds', () => {
    const t = theme('a meadow');
    expect(envFor(t, 5).id).toBe(envFor(t, 5).id);
    const ids = new Set(Array.from({ length: 12 }, (_, seed) => envFor(theme('xyz nowhere'), seed).id));
    expect(ids.size).toBeGreaterThan(1);
  });

  it('always returns an entry of the catalog', () => {
    const ids = new Set(catalog.entries.map((entry) => entry.id));
    for (const setting of ['', 'mars', 'a city street at night', 'kitchen']) expect(ids.has(envFor(theme(setting), 3).id)).toBe(true);
  });
});

describe('corpus coverage', () => {
  it('covers the 30 + 10 corpus sentences', () => {
    expect(coverage.sentences.length).toBe(40);
  });

  it('does not fall below the share written in the README', () => {
    // Podíl vět se slovem prostředí v checklistu, jejichž panorama to slovo nese (evals/play/env/README.md).
    expect(coverage.share).toBeGreaterThanOrEqual(0.818);
  });
});
