/**
 * Záznamy manifestu z katalogu (P32C T1). Loď zařazená jako auto okem projde –
 * vypadá jako legitimní výběr –, proto test drží třídu lodí, licenci ze
 * `disclosure.json` a počet záznamů; soubor `entries/catalog.ts` musí být
 * přesně to, co z dnešních vstupů vyrobí generátor.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog-index.json';
import rigged from '@/assets/rigged.json';

import disclosure from '../../../../disclosure.json';
import forward from '../../../../scripts/assets/p32-forward.json';
import { catalogEntries } from '../../../../scripts/assets/p32-manifest.mjs';
import { BASE_ENTRIES } from '../entries/base';
import { CATALOG_ENTRIES } from '../entries/catalog';
import { assetEntrySchema } from '../manifest';

/**
 * Počet záznamů 29. 9. 2026 – mění se jen vědomě, s novým modelem v katalogu nebo novým slovem třídy.
 * 3. 10.: +3 z pilotu P37D (frog, submarine, monster truck – ostatní nová jména třídu nemají).
 * 7. 10.: −1 ze slepého soudu P43 T13 (`gen3d-stage-magician` nepoznatelný, hrdinu nehraje).
 * 7. 10.: +1 z P43 T12 (`gen3d-caveman`; ostatních 16 nových jmen třídu nemá).
 * 23. 10.: +4 z P58A T7 (lizard, trout, blacksmith, hostage; bun, rail a dumpling třídu nemají).
 * 27. 10.: +2 z P62 T2 (cheetah, termite; snowplow, firecracker, pinecone a stalactite třídu nemají).
 * 5. 11.: +1 z P71E T2 (`gen3d-wyvern` s tagem `dragon` – drak místo netopýřího létajícího draka).
 * 5. 11.: +1 z P71E T2c (`cc0-ship-large`, Kenney, s tagem `pirate ship` – generovaná loď byla černá skvrna).
 */
const COUNT = 269;

const LICENSES = new Map(disclosure.entries.map((entry) => [entry.name, entry.license]));
const TAGS = new Map(catalog.assets.map((asset) => [asset.path, asset.tags]));

describe('manifest entries of the catalog (P32C T1)', () => {
  it('is exactly what the generator writes from today’s inputs', () => {
    expect(CATALOG_ENTRIES).toEqual(catalogEntries({ catalog, rigged, disclosure, forward }));
  });

  it('every entry passes the schema, its file exists and ids stay unique with the base entries', () => {
    for (const entry of CATALOG_ENTRIES) {
      const parsed = assetEntrySchema.safeParse(entry);
      expect(parsed.success, `${entry.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(existsSync(join(process.cwd(), 'public', entry.file)), entry.file).toBe(true);
    }
    const all = [...BASE_ENTRIES, ...CATALOG_ENTRIES];
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
    expect(new Set(all.map((entry) => entry.file)).size).toBe(all.length);
  });

  it('the licence is the one disclosure.json records for the file', () => {
    for (const entry of CATALOG_ENTRIES) expect(entry.license, entry.id).toBe(LICENSES.get(`public${entry.file}`));
  });

  it('no model tagged ship or boat is a vehicle', () => {
    for (const entry of CATALOG_ENTRIES) {
      const words = (TAGS.get(entry.file) ?? []).flatMap((tag) => tag.split(/[\s-]+/));
      if (words.some((word) => /^(ship|boat)s?$/.test(word))) expect(entry.class, entry.id).not.toBe('vehicle');
    }
    const boats = ['rowing-boat', 'cc0-boat-row', 'cc0-canoe', 'cc0-ship-ghost', 'gen3d-pirate-ship', 'gen3d-sailboat', 'gen3d-motorboat', 'gen3d-raft', 'gen3d-wooden-ark-boat'];
    for (const id of boats) expect(CATALOG_ENTRIES.find((entry) => entry.id === id)?.class, id).toBe('boat');
  });

  it('describes the heroes and foes of the P32 sentences that the catalog has', () => {
    const classOf = (id: string) => CATALOG_ENTRIES.find((entry) => entry.id === id)?.class;
    expect(classOf('gen3d-firefighter')).toBe('humanoid');
    expect(classOf('gen3d-pirate-captain')).toBe('humanoid');
    expect(classOf('cat')).toBe('animal');
    expect(classOf('dog')).toBe('animal');
    expect(classOf('rocket')).toBe('aircraft');
    expect(classOf('robot')).toBe('robot');
    expect(classOf('ghost')).toBe('monster');
    expect(classOf('gen3d-polar-bear')).toBe('animal');
    expect(classOf('cc0-shark')).toBe('animal');
    // Kulisa se slovem třídy hrdinou není.
    for (const id of ['cc0-bear-trap', 'gen3d-wizard-hat', 'gen3d-bus-stop', 'bird-nest', 'gen3d-hot-dog', 'gen3d-cat-tree', 'gen3d-fish-tank', 'gen3d-hamster-wheel', 'gen3d-robot-arm', 'gen3d-termite-hill']) {
      expect(classOf(id), id).toBeUndefined();
    }
  });

  it('keeps the entry count pinned', () => {
    expect(CATALOG_ENTRIES).toHaveLength(COUNT);
  });
});
