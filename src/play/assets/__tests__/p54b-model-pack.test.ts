/**
 * Balík modelů pro žánry P54C (P54B T12). P54C kreslí dílky podle stálých id
 * z `evals/play/p54b/model-pack.json`; id, které katalog ani manifest nezná, scéna
 * nakreslí jako barevný kvádr a na snímku to vypadá jako rozbitá hra, ne jako chyba
 * dat. Test proto drží, že každá žádost (`model-requests.json`) má dost modelů,
 * každé id vede přes `sceneModelOf` ze svého popisku, soubor leží v `public/` a třída
 * pohybu sedí s `catalog-motion.json` (postavy s kostrou s manifestem).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import catalogIndex from '@/assets/catalog-index.json';
import catalogMotion from '@/assets/catalog-motion.json';
import { RIGGED_PREFIX, sceneModelOf } from '@/play/arcade/models';

import pack from '../../../../evals/play/p54b/model-pack.json';
import requests from '../../../../evals/play/p54b/model-requests.json';
import { RIGGED_P54_ENTRIES } from '../entries/rigged-p54';

type PackModel = { id: string; label: string; class: string; height: number };
type PackItem = { character: boolean; models: PackModel[] };

const items = pack.items as Record<string, PackItem>;
const PATH_OF: ReadonlyMap<string, string> = new Map(catalogIndex.assets.map((asset) => [asset.assetId, asset.path]));
const MOTION = catalogMotion.models as Record<string, { class: string }>;
const RIGGED = new Map(RIGGED_P54_ENTRIES.map((entry) => [entry.id, entry]));
const PUBLIC = join(process.cwd(), 'public');

/** Soubor a třída id: katalog, nebo riggovaná postava T3 (`rigged:q-…`). */
function resolve(id: string): { file: string; class: string } | undefined {
  if (id.startsWith(RIGGED_PREFIX)) {
    const entry = RIGGED.get(id.slice(RIGGED_PREFIX.length));
    return entry === undefined ? undefined : { file: entry.file, class: entry.class };
  }
  const file = PATH_OF.get(id);
  return file === undefined || MOTION[id] === undefined ? undefined : { file, class: MOTION[id].class };
}

describe('model pack for P54C genres (P54B T12)', () => {
  it('answers every request with at least its minimum of distinct models', () => {
    expect(requests.requests.length).toBeGreaterThanOrEqual(12);
    for (const request of requests.requests) {
      const ids = items[request.item]?.models.map((model) => model.id) ?? [];
      expect(new Set(ids).size, request.item).toBe(ids.length);
      expect(ids.length, request.item).toBeGreaterThanOrEqual(Math.max(3, request.min));
    }
    expect(Object.keys(items).sort()).toEqual(requests.requests.map((request) => request.item).sort());
  });

  it('every id exists in the catalog or the manifest, with its file and motion class', () => {
    for (const [item, { models }] of Object.entries(items)) {
      for (const model of models) {
        const found = resolve(model.id);
        expect(found, `${item}: ${model.id}`).toBeDefined();
        expect(existsSync(join(PUBLIC, found!.file)), `${item}: ${found!.file}`).toBe(true);
        expect(model.class, `${item}: ${model.id}`).toBe(found!.class);
        expect(model.height, `${item}: ${model.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('the scene reaches every id from its label', () => {
    for (const [item, { character, models }] of Object.entries(items)) {
      for (const model of models) expect(sceneModelOf(model.label, character), `${item}: "${model.label}"`).toBe(model.id);
    }
  });

  it('the crowd is rigged characters that idle and cheer', () => {
    for (const { id } of items.crowd!.models) {
      const entry = RIGGED.get(id.slice(RIGGED_PREFIX.length));
      expect(id.startsWith(RIGGED_PREFIX) && entry?.clips.idle !== 'procedural' && entry?.clips.win !== undefined, id).toBe(true);
    }
  });

  it('merge items come in six growing sizes', () => {
    const heights = items.merge!.models.map((model) => model.height);
    expect(heights).toHaveLength(6);
    for (let size = 1; size < heights.length; size++) expect(heights[size]).toBeGreaterThan(heights[size - 1]!);
  });
});
