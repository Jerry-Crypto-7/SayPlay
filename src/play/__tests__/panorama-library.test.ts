/**
 * Předpečená panoramata (P30A T4): výběr nejbližšího podle slov prostředí,
 * deterministicky, jen z upečených položek; bez služby je dostane hra místo
 * `unavailable`. Soubory v `public/play/env/` drží strop počtu i velikosti a
 * každý má záznam v `disclosure.json`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { customEnvState } from '@/app/api/play/_env';
import { BAKED_ENVS, type BakedEnv, nearestBaked } from '@/play/env/library';
import manifest from '@/play/env/baked.json';

const PUBLIC = 'public/play/env';
/** Strop z plánu P30A T4: statická sada nesmí nafouknout nasazení. */
const MAX_FILES = 60;
const MAX_BYTES = 25 * 1024 * 1024;

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

  it('offers exactly the vocabulary entries that have a horizon and both files on disk', () => {
    const withHorizon = manifest.entries.filter((entry) => 'horizon' in entry).map((entry) => entry.id);
    expect(BAKED_ENVS.map((baked) => baked.id)).toEqual(withHorizon);
    for (const baked of BAKED_ENVS) {
      expect(existsSync(join('public', baked.url)), baked.url).toBe(true);
      expect(existsSync(join('public', baked.low)), baked.low).toBe(true);
    }
  });

  it('bakes every vocabulary entry or lists it as missing', () => {
    const missing = readFileSync('evals/play/p30/panorama-missing.txt', 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t')[0]);
    const baked = new Set(BAKED_ENVS.map((entry) => entry.id));
    for (const entry of manifest.entries) expect(baked.has(entry.id) || missing.includes(entry.id), entry.id).toBe(true);
  });
});

describe('the game without the panorama service', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PLAY_ENV_ENDPOINT;
    delete process.env.PLAY_ENV_ENDPOINT;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.PLAY_ENV_ENDPOINT = saved;
  });

  it('gets the nearest baked panorama, the library scene, or nothing', async () => {
    expect(await customEnvState('a snowy forest')).toEqual({ status: 'library' });
    expect(await customEnvState('a breakfast table')).toMatchObject({ status: 'ready', id: 'baked-breakfast-table', url: '/play/env/breakfast-table.webp', low: '/play/env/breakfast-table-low.webp' });
    expect(await customEnvState('inside a giant cuckoo clock')).toEqual({ status: 'unavailable' });
  });
});

describe('the baked files', () => {
  const files = existsSync(PUBLIC) ? readdirSync(PUBLIC) : [];

  it(`stay within ${String(MAX_FILES)} files and ${String(MAX_BYTES / 1024 / 1024)} MB`, () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(MAX_FILES);
    expect(files.reduce((sum, name) => sum + statSync(join(PUBLIC, name)).size, 0)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('each have a disclosure entry', () => {
    const names = new Set((JSON.parse(readFileSync('disclosure.json', 'utf8')) as { entries: { name: string }[] }).entries.map((entry) => entry.name));
    for (const name of files) expect(names.has(`${PUBLIC}/${name}`), name).toBe(true);
  });
});

describe('the bake script', () => {
  it('never reads the sealed test set', () => {
    expect(readFileSync('scripts/cloud/bake-panoramas.mjs', 'utf8')).not.toMatch(/test-200/);
  });
});
