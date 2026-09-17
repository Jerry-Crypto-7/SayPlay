import catalog from './catalog.json';
import { createAssetManifest } from './manifest';

/** Production allowlist, shared by the compiler, proxy and GLB loader. */
export const WORLDSTREAM_ASSETS = createAssetManifest(catalog);
