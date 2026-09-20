import type { Bounds3, Vec3 } from '@/shape/types';
import type { SlotTransform } from '@/worldstream/slots';
import { assetCatalogSchema, assetReferenceSchema, type AssetRecord } from './schema';
import { fitRotatedBounds } from './transform';

export type AssetManifest = ReturnType<typeof createAssetManifest>;

/** Lookup only resolves validated identity/version/hash. It never fetches a URL. */
export function createAssetManifest(input: unknown) {
  const catalog = assetCatalogSchema.parse(input);
  const entries = new Map(catalog.assets.map((asset) => [`${asset.assetId}@${asset.version}`, asset]));
  return {
    candidates(): readonly AssetRecord[] { return structuredClone(catalog.assets); },
    resolve(reference: unknown): { ok: true; asset: AssetRecord } | { ok: false; reason: string } {
      const parsed = assetReferenceSchema.safeParse(reference);
      if (!parsed.success) return { ok: false, reason: 'Invalid asset reference' };
      const asset = entries.get(`${parsed.data.assetId}@${parsed.data.version}`);
      if (!asset) return { ok: false, reason: 'Asset ID/version is not in the approved catalog' };
      if (asset.hash !== parsed.data.hash) return { ok: false, reason: 'Asset content hash is stale or mismatched' };
      // A caller cannot mutate subsequent resolutions or catalog collision data.
      return { ok: true, asset: structuredClone(asset) };
    },
  };
}

/** Bottom-centered contain fit preserves people/furniture proportions by default.
 * Stretch requires both an explicit request and import-time permission per axis. */
export function fitAsset(asset: Pick<AssetRecord, 'bounds' | 'stretchableAxes'>, target: Bounds3,
  stretchAxes: readonly ('x' | 'y' | 'z')[] = [], rotationY = 0): SlotTransform {
  if (!Number.isFinite(rotationY)) throw new Error('Asset yaw must be finite');
  if (rotationY !== 0) {
    if (stretchAxes.length) throw new Error('Rotated anisotropic asset stretch is unsupported');
    return fitRotatedBounds(asset.bounds,target,rotationY);
  }
  const axes = ['x', 'y', 'z'] as const;
  if (new Set(stretchAxes).size !== stretchAxes.length || stretchAxes.some((axis) => !asset.stretchableAxes.includes(axis)))
    throw new Error('Requested stretch is not approved for this asset');
  const sizes = (b: Bounds3) => b.max.map((value, axis) => value - b.min[axis]);
  const sourceSize = sizes(asset.bounds);
  const targetSize = sizes(target);
  if ([...asset.bounds.min, ...asset.bounds.max, ...target.min, ...target.max].some((value) => !Number.isFinite(value))
    || [...sourceSize, ...targetSize].some((size) => !Number.isFinite(size) || size <= 0)) throw new Error('Fit requires finite positive bounds');
  const ratios = targetSize.map((size, axis) => size / sourceSize[axis]);
  const uniform = Math.min(...ratios);
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) throw new Error('Fit scale is outside numeric limits');
  const scale = axes.map((axis, i) => stretchAxes.includes(axis) ? ratios[i] : uniform) as unknown as Vec3;
  const translation = axes.map((_, i) => i === 1
    ? target.min[i] - asset.bounds.min[i] * scale[i]
    : (target.min[i] + target.max[i]) / 2 - (asset.bounds.min[i] + asset.bounds.max[i]) / 2 * scale[i]) as unknown as Vec3;
  if (translation.some((value) => !Number.isFinite(value))) throw new Error('Fit translation is outside numeric limits');
  return { scale, translation };
}
