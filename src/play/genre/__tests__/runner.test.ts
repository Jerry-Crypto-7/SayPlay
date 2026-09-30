/**
 * Modul žánru Běžec (P32A T7). Špatná role („race car“ místo tučňáka, kužel
 * místo kamene) vypadá pořád jako hra, jen ne ta z věty – oko to nepozná.
 */

import { describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { heroFor } from '@/play/assets/manifest';
import { readGameSpec } from '@/play/spec';

import penguin from '../__fixtures__/penguin.json';
import { type GenreSpecOf, genreSpecSchema } from '../contract';
import { readGenreSpec } from '../index';
import { runnerGenre } from '../runner';

const PENGUIN_SENTENCE = 'A penguin slides down an icy mountain, collects snowflakes and avoids rocks';

const base: GenreSpecOf<'runner'> = { genre: 'runner', mode: 'default', hero: 'penguin', enemy: 'rock', collectible: 'snowflake', setting: 'icy mountain slope' };

function firstWinningSeed(spec: Parameters<typeof compileArcade>[0]): ReturnType<typeof compileArcade> {
  let last: ReturnType<typeof compileArcade> | null = null;
  for (let seed = 1; seed <= 8; seed += 1) {
    last = compileArcade(spec, seed);
    if (last.ok) return last;
  }
  return last as ReturnType<typeof compileArcade>;
}

describe('runner genre (P32A T7)', () => {
  it('draftFill reads the penguin sentence: hero, obstacle, collectible and setting', () => {
    const fill = runnerGenre.draftFill(PENGUIN_SENTENCE, null);
    expect(fill).toMatchObject({ genre: 'runner', mode: 'default', hero: 'penguin', enemy: 'rock', collectible: 'snowflake', palette: 'snow' });
    expect(fill.setting).toMatch(/icy mountain/);
  });

  it('the reference AI version is a valid genre spec', () => {
    const read = readGenreSpec(penguin);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value).toMatchObject({ genre: 'runner', hero: 'penguin' });
  });

  it('compile(penguin.json) reads, the bot wins and the hero is the penguin model', () => {
    const spec = runnerGenre.compile(genreSpecSchema.parse(penguin) as GenreSpecOf<'runner'>);
    const read = readGameSpec(spec);
    if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
    const compiled = firstWinningSeed(read.value);
    if (!compiled.ok) throw new Error(`${compiled.reason}: ${compiled.issues.join('; ')}`);
    expect(compiled.value.winsAtTick).toBeGreaterThan(0);
    const player = read.value.roles.find((role) => role.kind === 'player')!;
    expect(heroFor(player.label, 'runner')?.id).toBe('penguin');
    expect(read.value.roles.find((role) => role.id === 'obstacle')?.label).toBe('rock');
    expect(read.value.roles.find((role) => role.kind === 'collectible')?.label).toBe('snowflake');
    expect(read.value.theme.look).toBe('snow');
  });

  it('picks the look from the setting when the spec names no palette', () => {
    expect(runnerGenre.compile(base).theme.look).toBe('snow');
    expect(runnerGenre.compile({ ...base, setting: 'sandy desert canyon' }).theme.look).toBe('desert');
    expect(runnerGenre.compile({ ...base, palette: 'castle' }).theme.look).toBe('castle');
  });

  it('a rock cannot be slid under: only the dodge-or-jump obstacle kinds carry it', () => {
    expect(runnerGenre.compile(base).controlParams).toMatchObject({ obstacles: expect.not.arrayContaining(['slide-bar']) });
    expect(runnerGenre.compile({ ...base, enemy: 'low branch' }).controlParams).toMatchObject({ obstacles: expect.arrayContaining(['slide-bar']) });
  });

  it('maps speed and density params to the runner piece inside their bounds', () => {
    expect(runnerGenre.compile({ ...base, params: { speed: 2, density: 0, lengthM: 300 } }).controlParams).toMatchObject({ speed: 'fast', density: 'low', lengthM: 300 });
    expect(readGenreSpec({ ...base, params: { speed: 3 } }).ok).toBe(false);
    expect(readGenreSpec({ ...base, params: { density: -1 } }).ok).toBe(false);
  });

  it('cues cover the ways a sentence says "run down a track"', () => {
    for (const cue of ['slide', 'ski', 'run', 'surf', 'sled', 'escape', 'dash', 'race down']) expect(runnerGenre.cues).toContain(cue);
  });
});
