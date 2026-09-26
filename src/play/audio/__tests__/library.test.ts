/**
 * Vlastní hudba a zvuky hry (P29D T5): co hra zahraje, deterministicky podle
 * vzhledu a nálady, a poctivý návrat k ZzFX, když soubor nebo katalog chybí.
 */

import { describe, expect, it } from 'vitest';

import { LOOK_IDS } from '@/play/arcade/look';

import { moodOf, musicEnabled, musicFor, sfxFor } from '../library';
import musicCatalog from '../music-catalog.json';
import sfxCatalog from '../sfx-catalog.json';

const EVENTS = ['jump', 'pickup', 'hit', 'win', 'lose'] as const;

describe('music for a game', () => {
  it('the look and the mood of the theme pick the loop, the same one every time', () => {
    const calm = { setting: 'a sunny beach', mood: 'relaxed' };
    const tense = { setting: 'a haunted castle', mood: 'scary' };
    expect(musicFor(calm)).toBe('/assets/worldstream/audio/music/beach-calm.ogg');
    expect(musicFor(calm)).toBe(musicFor({ ...calm }));
    expect(musicFor(tense)).toBe('/assets/worldstream/audio/music/castle-tense.ogg');
  });

  it('the director’s look wins over the words; unknown words fall back to the meadow', () => {
    expect(musicFor({ setting: 'a beach', mood: 'calm', look: 'space' })).toBe('/assets/worldstream/audio/music/space-calm.ogg');
    expect(musicFor({ setting: 'nowhere in particular', mood: '' })).toBe('/assets/worldstream/audio/music/meadow-calm.ogg');
  });

  it('danger in the mood or the setting makes the loop tense, the rest is calm', () => {
    expect(moodOf({ setting: 'a lava field', mood: '' })).toBe('tense');
    expect(moodOf({ setting: 'a park', mood: 'fast and frantic' })).toBe('tense');
    expect(moodOf({ setting: 'a park', mood: 'cheerful' })).toBe('calm');
  });

  it('an empty or partial catalog means silence, not a wrong loop', () => {
    expect(musicFor({ setting: 'beach', mood: '' }, { loops: {} })).toBeNull();
    expect(musicFor({ setting: 'beach', mood: 'scary' }, { loops: { beach: { calm: '/x.ogg' } } })).toBeNull();
  });

  it('PLAY_MUSIC=off turns the music off, anything else leaves it on', () => {
    expect(musicEnabled('off')).toBe(false);
    expect(musicEnabled(' OFF ')).toBe(false);
    expect(musicEnabled(undefined)).toBe(true);
    expect(musicEnabled('on')).toBe(true);
  });
});

describe('sound effects for a look', () => {
  it('every look has its own file for every event', () => {
    for (const look of LOOK_IDS) {
      for (const event of EVENTS) expect(sfxFor(look, event)).toBe(`/assets/worldstream/audio/sfx/${look}-${event}.ogg`);
    }
  });

  it('a missing look or event falls back to ZzFX (null)', () => {
    expect(sfxFor('beach', 'jump', { sounds: {} })).toBeNull();
    expect(sfxFor('beach', 'win', { sounds: { beach: { jump: '/j.ogg' } } })).toBeNull();
  });

  it('the catalogs cover all looks – a new look without sound shows up here', () => {
    expect(Object.keys(musicCatalog.loops)).toEqual([...LOOK_IDS]);
    expect(Object.keys(sfxCatalog.sounds)).toEqual([...LOOK_IDS]);
  });
});
