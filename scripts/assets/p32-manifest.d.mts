/** Typy k `p32-manifest.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

import type { AssetEntry } from '../../src/play/assets/manifest';

export declare function catalogEntries(inputs: { catalog: unknown; rigged: unknown; disclosure: unknown; forward: unknown; handClasses?: Record<string, string> }): AssetEntry[];
