/**
 * Modul žánru Běžec (P32A T7). Špatná role („race car“ místo tučňáka, kužel
 * místo kamene) vypadá pořád jako hra, jen ne ta z věty – oko to nepozná.
 */

import { describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { LOOKS, sceneLook } from '@/play/arcade/look';
import { heroFor } from '@/play/assets/manifest';
import { readGameSpec } from '@/play/spec';

import penguin from '../__fixtures__/penguin.json';
import { type GenreSpecOf, genreSpecSchema, legacyCast } from '../contract';
import { compileGenre, readGenreSpec } from '../index';
import { runnerGenre } from '../runner';

const PENGUIN_SENTENCE = 'A penguin slides down an icy mountain, collects snowflakes and avoids rocks';

const base: GenreSpecOf<'runner'> = {
  genre: 'runner',
  mode: 'default',
  hero: 'penguin',
  cast: [
    { label: 'rock', does: 'avoid' },
    { label: 'snowflake', does: 'collect' },
  ],
  setting: 'icy mountain slope',
};

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
    expect(fill).toMatchObject({ genre: 'runner', mode: 'default', hero: 'penguin', palette: 'snow' });
    expect(fill.cast).toEqual(expect.arrayContaining([{ label: 'rock', does: 'avoid' }, { label: 'snowflake', does: 'collect' }]));
    expect(fill.setting).toMatch(/icy mountain/);
  });

  it('the reference AI version is a valid genre spec', () => {
    const read = readGenreSpec(penguin);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value).toMatchObject({ genre: 'runner', hero: 'penguin' });
  });

  it('compile(penguin.json) reads, the bot wins and the hero is the penguin model', () => {
    const spec = runnerGenre.compile(genreSpecSchema.parse(legacyCast(penguin)) as GenreSpecOf<'runner'>);
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
    expect(runnerGenre.compile({ ...base, cast: [{ label: 'low branch', does: 'avoid' }] }).controlParams).toMatchObject({ obstacles: expect.arrayContaining(['slide-bar']) });
  });

  it('maps speed and density params to the runner piece inside their bounds', () => {
    expect(runnerGenre.compile({ ...base, params: { speed: 2, density: 0, lengthM: 300 } }).controlParams).toMatchObject({ speed: 'fast', density: 'low', lengthM: 300 });
    expect(readGenreSpec({ ...base, params: { speed: 3 } }).ok).toBe(false);
    expect(readGenreSpec({ ...base, params: { density: -1 } }).ok).toBe(false);
  });

  it('a sentence that slides, skis or surfs reaches the scene as theme.motion "ride" (T5-R1)', () => {
    for (const sentence of [PENGUIN_SENTENCE, 'A girl skis down the slope', 'A surfer rides the waves', 'A kid sleds down the hill', 'A boy skateboards through the city', 'A fox toboggans home']) {
      const fill = runnerGenre.draftFill(sentence, null);
      expect(fill.params, sentence).toEqual({ ride: 1 });
      const read = readGenreSpec({ ...base, ...fill });
      if (!read.ok) throw new Error(read.issues.join('; '));
      expect(compileGenre(read.value).theme.motion, sentence).toBe('ride');
    }
    // „skips“ ani „skin“ jízda nejsou; bez jízdy je `theme` bez pole, jak ho hra měla před T5-R1.
    for (const sentence of ['A boy skips over puddles', 'A cat with shiny skin runs', 'A knight runs through the castle']) {
      expect(runnerGenre.draftFill(sentence, null).params, sentence).toBeUndefined();
    }
    expect(Object.keys(runnerGenre.compile(base).theme).sort()).toEqual(['look', 'mood', 'setting']);
    expect(runnerGenre.compile({ ...base, params: { ride: 0 } }).theme).not.toHaveProperty('motion');
    expect(readGenreSpec({ ...base, params: { ride: 2 } }).ok).toBe(false);
  });

  it('theme.motion is look-only: the old game reads as before and the kernel state is the same with or without it', () => {
    const old = runnerGenre.compile(genreSpecSchema.parse(legacyCast(penguin)) as GenreSpecOf<'runner'>);
    const riding = { ...old, theme: { ...old.theme, motion: 'ride' as const } };
    expect(readGameSpec(old).ok).toBe(true);
    expect(readGameSpec(riding).ok).toBe(true);
    expect(readGameSpec({ ...old, theme: { ...old.theme, motion: 'fly' } }).ok).toBe(false);
    const before = compileArcade(old, 1);
    const after = compileArcade(riding, 1);
    if (!before.ok || !after.ok) throw new Error('penguin did not compile');
    expect(after.value.worldHash).toBe(before.value.worldHash);
    expect(after.value.winsAtTick).toBe(before.value.winsAtTick);
    // Scéna: jízda z `theme.motion`, stará hra dostane sadu beze změny (tentýž objekt).
    expect(sceneLook(riding.theme).ride).toBe(true);
    expect(sceneLook(old.theme)).toBe(LOOKS.snow);
  });

  it('cues cover the ways a sentence says "run down a track"', () => {
    for (const cue of ['slide', 'ski', 'run', 'surf', 'sled', 'escape', 'dash', 'race down']) expect(runnerGenre.cues).toContain(cue);
  });
});
