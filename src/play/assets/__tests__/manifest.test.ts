/**
 * Manifest modelů hrdinů (P32-0 T6). Špatná identita vypadá jako „nějaký
 * hrdina“ a okem projde – proto test drží, že identita z věty má přednost
 * před třídou modelu, i když je v manifestu jiný pták dřív.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import rigged from '@/assets/rigged.json';

import { BASE_ENTRIES } from '../entries/base';
import { type AssetEntry, assetEntrySchema, heroFor } from '../manifest';

/** Návnada: pták stejné třídy, zapsaný před tučňákem. */
const PARROT: AssetEntry = {
  id: 'parrot',
  file: '/assets/worldstream/game/penguin-lod0.glb',
  identity: ['parrot'],
  class: 'bird',
  dims: [0.5, 0.6, 0.4],
  pivot: 'base',
  forward: '+z',
  clips: { idle: 'procedural', run: 'procedural', jump: 'procedural', hit: 'procedural', die: 'procedural' },
  fallback: '#16a34a',
  license: 'CC0-1.0',
  preload: ['runner'],
};

describe('hero asset manifest (P32-0 T6)', () => {
  it('every file exists under public/', () => {
    for (const entry of BASE_ENTRIES) expect(existsSync(join(process.cwd(), 'public', entry.file)), entry.file).toBe(true);
  });

  it('every entry passes the schema and ids are unique', () => {
    for (const entry of BASE_ENTRIES) {
      const parsed = assetEntrySchema.safeParse(entry);
      expect(parsed.success, `${entry.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
    expect(new Set(BASE_ENTRIES.map((entry) => entry.id)).size).toBe(BASE_ENTRIES.length);
  });

  it('describes every rigged character and the penguin', () => {
    // Plán psal 16 postav; `rigged.json` jich 29. 9. 2026 nese 15.
    const files = new Set(BASE_ENTRIES.map((entry) => entry.file));
    for (const character of rigged.characters) expect(files.has(character.path), character.id).toBe(true);
    expect(files.has('/assets/worldstream/game/penguin-lod0.glb')).toBe(true);
    expect(BASE_ENTRIES).toHaveLength(rigged.characters.length + 1);
  });

  it('heroFor("penguin", "runner") is the penguin, not another bird', () => {
    expect(heroFor('penguin', 'runner')?.id).toBe('penguin');
    expect(heroFor('penguin', 'runner', [PARROT, ...BASE_ENTRIES])?.id).toBe('penguin');
    expect(heroFor('a tiny penguins', 'runner', [PARROT, ...BASE_ENTRIES])?.id).toBe('penguin');
  });

  it('identity wins over the genre, the class is only the last resort', () => {
    expect(heroFor('tiny wizard', 'quest')?.id).toBe('mage');
    // Žádná identita „eagle“: třída bird, kterou běžec bere.
    expect(heroFor('eagle', 'runner', [PARROT, ...BASE_ENTRIES])?.class).toBe('bird');
    // Plavba ptáka za hrdinu nebere – třída tu nepomůže.
    expect(heroFor('eagle', 'voyage', [PARROT, ...BASE_ENTRIES])).toBeNull();
    expect(heroFor('toaster', 'runner')).toBeNull();
  });
});
