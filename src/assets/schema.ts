import { z } from 'zod';

/** Catalog identity is data. Adding a noun never requires a TypeScript enum. */
export const assetIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const identifier = assetIdSchema;
const bounds = z.object({ min: vector, max: vector }).strict()
  .refine((b) => b.max.every((value, axis) => Number.isFinite(value - b.min[axis]) && value > b.min[axis]), 'Bounds must have finite positive volume');

// Only normalized local files. No URL, traversal, escaped path, query or fragment.
export const assetPathSchema = z.string().regex(/^\/assets\/worldstream\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.glb$/);
const localImage = z.string().regex(/^\/assets\/worldstream\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|jpg|webp)$/);

export const assetReferenceSchema = z.object({
  kind: z.literal('asset'), assetId: identifier, version: z.int().positive(), hash: contentHashSchema,
}).strict();

const socket = z.object({ id: identifier, at: vector,
  normal: vector.refine((v) => Math.abs(Math.hypot(...v) - 1) < 0.0001, 'Socket normal must be a unit vector'),
}).strict();

const collider = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), bounds }).strict(),
  z.object({ kind: z.literal('sphere'), center: vector, radius: z.number().finite().positive() }).strict(),
]);

const lod = z.object({
  level: z.int().nonnegative(), path: assetPathSchema, hash: contentHashSchema,
  bytes: z.int().positive(), triangles: z.int().nonnegative(),
  decodedGeometryBytes: z.int().nonnegative(), decodedTextureBytes: z.int().nonnegative(),
  minScreenPixels: z.number().finite().nonnegative(),
}).strict();

/** All positions are meters in the normalized GLB's local frame, including pivot,
 * sockets, collision and support surfaces. Normalization is an import operation;
 * viewers never guess the source units or silently rescale individual axes. */
export const assetRecordSchema = z.object({
  assetId: identifier, version: z.int().positive(), hash: contentHashSchema,
  label: z.string().min(1).max(160), tags: z.array(z.string().min(1).max(80)).min(1).max(64),
  style: z.string().min(1).max(120), thumbnail: localImage,
  provenance: z.object({
    source: z.string().min(1).max(2048), author: z.string().min(1).max(160),
    license: z.string().min(1).max(160), licenseEvidence: z.string().min(1).max(2048),
    importedAt: z.string().date(), sourceHash: contentHashSchema,
  }).strict(),
  units: z.literal('meters'), up: z.literal('+Y'), front: z.literal('+Z'), pivot: vector,
  bounds, stretchableAxes: z.array(z.enum(['x', 'y', 'z'])).max(3),
  lods: z.array(lod).min(1).max(8),
  materials: z.array(z.object({ id: identifier, name: z.string().min(1),
    alphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']), doubleSided: z.boolean(),
  }).strict()).min(1).max(64),
  collision: z.array(collider).min(1).max(32), sockets: z.array(socket).max(64),
  supportSurfaces: z.array(z.object({ id: identifier, center: vector,
    width: z.number().finite().positive(), depth: z.number().finite().positive(),
  }).strict()).max(32),
  parts: z.array(z.object({ id: identifier, node: z.string().min(1).max(160),
    pivot: vector, sockets: z.array(identifier).max(32),
  }).strict()).max(64),
}).strict().superRefine((asset, context) => {
  const unique = (values: readonly (string | number)[], path: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path: [path], message: 'Duplicate identity' });
  };
  unique(asset.lods.map((l) => l.level), 'lods');
  unique(asset.materials.map((m) => m.id), 'materials');
  unique(asset.sockets.map((s) => s.id), 'sockets');
  unique(asset.parts.map((p) => p.id), 'parts');
  unique(asset.parts.map((p) => p.node), 'parts');
  unique(asset.supportSurfaces.map((s) => s.id), 'supportSurfaces');
  unique(asset.stretchableAxes, 'stretchableAxes');
  const base = asset.lods.find((l) => l.level === 0);
  if (!base || base.hash !== asset.hash) context.addIssue({ code: 'custom', path: ['lods'], message: 'LOD 0 must match the asset content hash' });
  const sockets = new Set(asset.sockets.map((s) => s.id));
  asset.parts.forEach((part, index) => {
    if (part.sockets.some((id) => !sockets.has(id))) context.addIssue({ code: 'custom', path: ['parts', index, 'sockets'], message: 'Part references an undeclared socket' });
  });
});

export const assetCatalogSchema = z.object({
  version: z.literal('worldstream-assets-v1'), assets: z.array(assetRecordSchema).max(10000),
}).strict().superRefine((catalog, context) => {
  const ids = catalog.assets.map((a) => `${a.assetId}@${a.version}`);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['assets'], message: 'Duplicate asset ID/version' });
});

export type AssetRecord = z.infer<typeof assetRecordSchema>;
export type AssetReference = z.infer<typeof assetReferenceSchema>;
export type AssetCatalog = z.infer<typeof assetCatalogSchema>;
