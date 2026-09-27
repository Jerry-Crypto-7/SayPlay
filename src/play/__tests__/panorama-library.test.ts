/**
 * Předpečená panoramata (P30A T4): výběr nejbližšího podle slov prostředí,
 * deterministicky, a jen z upečených položek. Zapojení do `_env.ts` a soubory
 * v `public/play/env/` dotahuje zbytek T4.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { type BakedEnv, nearestBaked } from '@/play/env/library';
import manifest from '@/play/env/baked.json';

const env = (id: string, words: string[]): BakedEnv => ({ id, prompt: id, words, horizon: '#000000', url: `/play/env/${id}.webp`, low: `/play/env/${id}-low.webp` });
const SET = [env('garage', ['garage', 'workshop']), env('pyramid', ['pyramid', 'egypt', 'tomb']), env('arctic', ['arctic', 'polar', 'north pole'])];

describe('nearestBaked', () => {
  it('picks the panorama whose words the setting names most, plural and synonyms included', () => {
    expect(nearestBaked('grandpa fixing a car in the garage', SET)?.id).toBe('garage');
    expect(nearestBaked('the pyramids of old Egypt', SET)?.id).toBe('pyramid');
    expect(nearestBaked('a polar base at the North Pole', SET)?.id).toBe('arctic');
  });

  it('breaks a tie by order and answers the same every time', () => {
    const both = 'a workshop inside a tomb';
    expect(nearestBaked(both, SET)?.id).toBe('garage');
    expect(nearestBaked(both, [...SET].reverse())?.id).toBe('pyramid');
    expect(nearestBaked(both, SET)?.id).toBe(nearestBaked(both, SET)?.id);
  });

  it('is null for a setting none of the words name, so the game keeps the library scene', () => {
    expect(nearestBaked('quantum foam', SET)).toBeNull();
    expect(nearestBaked('garages'.slice(0, 3), SET)).toBeNull();
  });

  it('never picks a vocabulary entry that has no baked files yet', () => {
    const unbaked = manifest.entries.filter((entry) => !('horizon' in entry)).map((entry) => entry.id);
    expect(unbaked.length).toBeGreaterThan(0);
    for (const entry of manifest.entries.filter((e) => !('horizon' in e))) expect(nearestBaked(entry.words.join(' '))?.id).not.toBe(entry.id);
  });
});

describe('the bake script', () => {
  it('never reads the sealed test set', () => {
    expect(readFileSync('scripts/cloud/bake-panoramas.mjs', 'utf8')).not.toMatch(/test-200/);
  });
});
