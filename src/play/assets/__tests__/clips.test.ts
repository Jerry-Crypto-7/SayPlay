/**
 * Klipy manifestu hrdinů v souborech (P32C T4). Klip pojmenovaný špatně
 * znamená, že hrdina stojí – a to vypadá jako idle, okem to projde. Test
 * načte každý GLB s klipy přes `@gltf-transform/core` a ověří, že každý
 * namapovaný klip v souboru je a trvá déle než 0 s. Nové postavy z T3 jsou
 * v manifestu s třídou, rozměrem a osou, které projdou schématem.
 */

import { join } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { describe, expect, it } from 'vitest';

import rigged from '@/assets/rigged-p32.json';

import { BASE_ENTRIES } from '../entries/base';
import { CATALOG_ENTRIES } from '../entries/catalog';
import { RIGGED_P32_ENTRIES } from '../entries/rigged-p32';
import { assetEntrySchema } from '../manifest';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const WITH_CLIPS = [...BASE_ENTRIES, ...RIGGED_P32_ENTRIES].filter((entry) => Object.values(entry.clips).some((clip) => clip !== 'procedural'));

describe('clips of the hero manifest (P32C T4)', () => {
  it.each(WITH_CLIPS.map((entry) => [entry.id, entry] as const))('%s: every mapped clip is in the GLB and lasts > 0 s', async (_, entry) => {
    const document = await io.read(join(process.cwd(), 'public', entry.file));
    const seconds = new Map(
      document
        .getRoot()
        .listAnimations()
        .map((animation) => [animation.getName(), Math.max(0, ...animation.listSamplers().map((sampler) => sampler.getInput()?.getMax([])[0] ?? 0))]),
    );
    for (const [state, clip] of Object.entries(entry.clips)) {
      if (clip === 'procedural') continue;
      expect(seconds.has(clip), `${entry.id}: ${state} → ${clip}`).toBe(true);
      expect(seconds.get(clip), `${entry.id}: ${clip}`).toBeGreaterThan(0);
    }
  });

  it('describes every P32 character with idle and run, passes the schema and keeps ids unique', () => {
    expect(RIGGED_P32_ENTRIES.map((entry) => entry.id)).toEqual(rigged.characters.map((character) => character.id));
    for (const entry of RIGGED_P32_ENTRIES) {
      const parsed = assetEntrySchema.safeParse(entry);
      expect(parsed.success, `${entry.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect([entry.clips.idle, entry.clips.run], entry.id).not.toContain('procedural');
    }
    const all = [...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES];
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
  });
});
