/**
 * Záznamy manifestu hrdinů z katalogu (P32C T1). Data v `catalog.json` píše
 * `node scripts/assets/p32-manifest.mjs` z `src/assets/catalog-index.json`,
 * `src/assets/rigged.json`, `disclosure.json` a `scripts/assets/p32-forward.json`
 * – needitovat ručně. JSON místo literálu: brána licencí čte cesty v kódu jako
 * jména modelů AI (`cc0-llama-lod1.glb`).
 */

import type { AssetEntry } from '../manifest';

import data from './catalog.json';

/** JSON nezná literály ani n-tice (třída je `string`, rozměry `number[]`); tvar každého záznamu drží `assetEntrySchema` v testu `catalog-entries`. */
export const CATALOG_ENTRIES = data.entries as unknown as readonly AssetEntry[];
