/**
 * Žádná cesta k modelu nevede na soubor, který v `public/` neleží (P71E T1).
 *
 * QA 5. 11. 2026: pták ve flap stahoval `/assets/worldstream/game/bird-lod1.glb` (404) při
 * každém načtení a kreslil se žlutou koulí. Katalogy samy byly v pořádku – cestu složil
 * `modelPath` z id, které žádný katalog nezná (výchozí hrdina flap a smysl slova „bird“).
 * Test proto hlídá obojí: každou cestu zapsanou v katalozích i každé id, které výběr hrdiny
 * scéně předá – pro všechny ovladače a holé popisky, které katalog nemá.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { heroChoice, modelOf, modelPath, sceneModelOf } from '@/play/arcade/models';
import { CONTROLS } from '@/play/spec';

const ROOT = process.cwd();
const PUBLIC = join(ROOT, 'public');

const CATALOGS = [
  'src/assets/catalog.json',
  'src/assets/catalog-index.json',
  'src/assets/rigged.json',
  'src/assets/rigged-p32.json',
  'src/assets/rigged-p54.json',
  'src/play/assets/entries/catalog.json',
] as const;

/** Každý řetězec `/assets/…` v souboru katalogu – cesty LOD, náhledy, soubory záznamů. */
function assetPaths(text: string): string[] {
  return [...new Set([...text.matchAll(/"(\/assets\/[^"]+)"/g)].map((match) => match[1] as string))];
}

function missingPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !existsSync(join(PUBLIC, path)));
}

describe('every catalog path points at a file', () => {
  it.each(CATALOGS)('%s', (file) => {
    const paths = assetPaths(readFileSync(join(ROOT, file), 'utf8'));
    expect(paths.length).toBeGreaterThan(0);
    expect(missingPaths(paths)).toEqual([]);
  });

  it('the check itself sees a path that is not there', () => {
    expect(missingPaths(assetPaths('{"path": "/assets/worldstream/game/bird-lod1.glb"}'))).toEqual(['/assets/worldstream/game/bird-lod1.glb']);
  });
});

/** Popisky bez modelu v katalogu (výchozí model role) a slova se smyslem mimo tagy (`WORD_SENSE`). */
const LABELS = ['stapler', 'zorbles', 'a tiny bird', 'little bird', 'birds', 'fish', 'turtle', 'tortoise'] as const;

describe('every model the hero choice hands the scene is a file', () => {
  it.each(CONTROLS)('control %s', (control) => {
    for (const label of LABELS) {
      for (const role of ['player', 'enemy'] as const) {
        const { model } = heroChoice(label, undefined, control, role);
        expect(existsSync(join(PUBLIC, modelPath(model))), `${role} „${label}“ → ${model} → ${modelPath(model)}`).toBe(true);
      }
    }
  });

  it.each(LABELS)('scene model of „%s“', (label) => {
    for (const model of [modelOf(label, true), sceneModelOf(label, true), sceneModelOf(label, false)]) {
      if (model === undefined) continue;
      expect(existsSync(join(PUBLIC, modelPath(model))), `${label} → ${model} → ${modelPath(model)}`).toBe(true);
    }
  });

  it('the bird of a flap game is a real bird model', () => {
    const { model, entry } = heroChoice('a tiny bird', 'flap', 'flap');
    expect(entry?.class).toBe('bird');
    expect(modelPath(model)).not.toBe('/assets/worldstream/game/bird-lod1.glb');
  });
});
