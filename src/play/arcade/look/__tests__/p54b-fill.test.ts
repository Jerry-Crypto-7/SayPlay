/**
 * Výplň sad bez vegetace (P54B T7). Pinuje se, co na snímku nikdo nepozná:
 * id, které v katalogu není, tiše nic nenakreslí (scéna zůstane prázdná a
 * vypadá jako záměr), fialový model ve výplni, a město nebo obchod, kterým by
 * výplň zředila řadu domů a regálů na jeden kus za 24 m.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog-index.json';

import { isPurple, toSrgb } from '../../../../../scripts/assets/cc0/palette.mjs';
import { FLORA_SPECIES, floraIds, LOOK_IDS, LOOKS, sparseLandmarks } from '../index';

const PUBLIC = join(__dirname, '..', '..', '..', '..', '..', 'public');
const PATHS: ReadonlyMap<string, string> = new Map(catalog.assets.map((asset) => [asset.assetId, asset.path]));
/** Sady, které vegetaci měly už před P54B (P46G). */
const NATURE = ['meadow', 'forest', 'jungle', 'desert', 'beach', 'snow'] as const;
const FILLED = LOOK_IDS.filter((id) => !(NATURE as readonly string[]).includes(id));

const fillOf = (id: (typeof LOOK_IDS)[number]): string[] => {
  const flora = LOOKS[id].flora;
  return flora === undefined ? [] : [...floraIds(flora)];
};

describe('P54B T7: výplň sad bez vegetace', () => {
  it('dvanáct sad dostalo výplň (hrad, město, hřbitov, vesmír, sopka, jeskyně, pod vodou, moře, interiéry)', () => {
    expect(FILLED).toHaveLength(12);
  });

  it.each(LOOK_IDS)('%s: aspoň 6 odlišných modelů výplně, nejvýš FLORA_SPECIES', (id) => {
    const ids = fillOf(id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(ids.length).toBeLessThanOrEqual(FLORA_SPECIES);
  });

  it('každé id výplně je v katalogu a jeho GLB leží v public/', () => {
    const ids = [...new Set(LOOK_IDS.flatMap(fillOf))];
    expect(ids.filter((id) => !PATHS.has(id))).toEqual([]);
    expect(ids.filter((id) => PATHS.has(id) && !existsSync(join(PUBLIC, PATHS.get(id)!)))).toEqual([]);
  });

  it('drobnost u cesty je i v největší velikosti (× 1,4) nižší než 2 m – kamera arény přes ni vidí na paty hrdiny', () => {
    const tall = LOOK_IDS.flatMap((id) => (LOOKS[id].flora?.near ?? []).filter((species) => species.height * 1.4 >= 2).map((species) => `${id} ${species.id}`));
    expect(tall).toEqual([]);
  });

  it('výplň nových sad nemá fialový vrchol (odstín 250–320°, sytost nad 0,25)', async () => {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const purple: string[] = [];
    for (const id of new Set(FILLED.flatMap(fillOf))) {
      const doc = await io.read(join(PUBLIC, PATHS.get(id)!));
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const factor = primitive.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
          const colour = primitive.getAttribute('COLOR_0');
          const count = primitive.getAttribute('POSITION')!.getCount();
          for (let i = 0; i < count; i += 1) {
            const linear = colour === null ? [1, 1, 1] : colour.getElement(i, []);
            if (isPurple(toSrgb([linear[0]! * factor[0]!, linear[1]! * factor[1]!, linear[2]! * factor[2]!]))) {
              purple.push(`${id} vrchol ${i}`);
              break;
            }
          }
        }
      }
    }
    expect(purple).toEqual([]);
  }, 30_000);

  it('sady s výplní nechají řadu kulis hustou; řídne jen vedle přírody', () => {
    // Domy, regály, stroje a hradby sadu poznávají – výplň je doplní, nenahradí.
    expect(FILLED.filter((id) => sparseLandmarks(LOOKS[id]))).toEqual([]);
    expect(NATURE.filter((id) => !sparseLandmarks(LOOKS[id]))).toEqual([]);
  });
});
