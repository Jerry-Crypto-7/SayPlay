import type { AssetRecord } from '../schema';
const hash = 'a'.repeat(64);
export const asset = (): AssetRecord => ({
  assetId: 'catalog.seated-person', version: 1, hash, label: 'Seated person',
  tags: ['person', 'seated'], style: 'stylized-realism', thumbnail: '/assets/worldstream/person/preview.png',
  provenance: { source: 'local-authoring', author: 'fixture', license: 'CC0-1.0',
    licenseEvidence: 'fixture-only, no distributed model', importedAt: '2026-09-17', sourceHash: hash },
  units: 'meters', up: '+Y', front: '+Z', pivot: [0, 0, 0],
  bounds: { min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] }, stretchableAxes: [],
  lods: [{ level: 0, path: '/assets/worldstream/person/model.glb', hash,
    bytes: 100, triangles: 12, decodedGeometryBytes: 1000, decodedTextureBytes: 0, minScreenPixels: 0 }],
  materials: [{ id: 'clothes', name: 'Clothes', alphaMode: 'OPAQUE', doubleSided: false }],
  collision: [{ kind: 'box', bounds: { min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] } }],
  sockets: [{ id: 'seat', at: [0, 0.7, 0], normal: [0, 1, 0] }],
  supportSurfaces: [], parts: [{ id: 'body', node: 'Body', pivot: [0, 0, 0], sockets: ['seat'] }],
});
