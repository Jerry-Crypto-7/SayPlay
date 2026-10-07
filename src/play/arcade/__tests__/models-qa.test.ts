/**
 * Slepý soud knihovny (P43 T13): model se štítkem `qa:unrecognisable` jméno z věty
 * nedostane a jméno ze soudu (`seen:`) nepřebije model, který slovo nese vlastním tagem –
 * pizza, která vypadá jako dort, by jinak pro „cake“ vypadala jako oprava.
 */

import { describe, expect, it } from 'vitest';

import { catalogEntries } from '../../../../scripts/assets/p32-manifest.mjs';
import { tagIndex, UNRECOGNISABLE } from '../models';

describe('tagIndex', () => {
  it('skips an unrecognisable model, tag and id alike', () => {
    const index = tagIndex([
      { assetId: 'blob', tags: ['blob', 'slime', UNRECOGNISABLE] },
      { assetId: 'cc0-slime', tags: ['slime'] },
    ]);
    expect(index.get('blob')).toBeUndefined();
    expect(index.get('slime')).toBe('cc0-slime');
  });

  it('gives a judged name only to a word no model carries itself', () => {
    const index = tagIndex([
      { assetId: 'pizza', tags: ['pizza', 'seen:birthday cake', 'seen:cake'] },
      { assetId: 'cc0-cake', tags: ['cake'] },
    ]);
    expect(index.get('pizza')).toBe('pizza');
    expect(index.get('cake')).toBe('cc0-cake');
    expect(index.get('birthday cake')).toBe('pizza');
  });
});

describe('catalogEntries', () => {
  it('leaves an unrecognisable model out of the hero manifest', () => {
    const asset = (assetId: string, tags: string[]) => ({ assetId, tags, path: `/assets/${assetId}.glb`, bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
    const entries = catalogEntries({
      catalog: { assets: [asset('cc0-fox', ['fox']), asset('cc0-wolf', ['wolf', UNRECOGNISABLE])] },
      rigged: { characters: [] },
      disclosure: { entries: [{ name: 'public/assets/cc0-fox.glb', license: 'CC0-1.0' }, { name: 'public/assets/cc0-wolf.glb', license: 'CC0-1.0' }] },
      forward: { models: {}, sets: {} },
    });
    expect(entries.map((entry: { id: string }) => entry.id)).toEqual(['cc0-fox']);
  });
});
