/** Hand-authored renderer oracles. Never imported by the live generator. Units: metres. */
import catalog from '../../../../src/assets/catalog.json';
import { blueprintSchema } from '../../../../src/worldstream/schema';
import { DEMO_BLUEPRINT } from '../../../../src/app/dev/demo-world';
import type { ShapeProgram, Vec3 } from '../../../../src/shape/types';

export type ReferenceId = 'interior' | 'courtyard' | 'observatory';
export type Ablation = 'full' | 'clay' | 'proxy' | 'layout' | 'light' | 'camera' | 'no-ibl' | 'no-shadows';
export interface Surface {
  id: string; kind: 'box' | 'cylinder' | 'sphere' | 'torus';
  at: Vec3; size: Vec3; color: string; rotation?: Vec3;
  metalness?: number; roughness?: number;
}
interface Asset { id: string; asset: string; at: Vec3; scale?: number }
export interface ReferenceScene {
  id: ReferenceId; title: string; description: string;
  target: Vec3; cameras: readonly Vec3[]; background: string;
  assets: Asset[]; surfaces: Surface[]; shape?: ShapeProgram;
  lamp: Vec3;
}
const box = (id: string, at: Vec3, size: Vec3, color: string): Surface => ({ id, kind: 'box', at, size, color });
const cylinder = (id: string, at: Vec3, radius: number, height: number, color: string): Surface =>
  ({ id, kind: 'cylinder', at, size: [radius, height, radius], color });
const seat = (id: string, x: number, z: number): Asset[] => [
  { id: `${id}Chair`, asset: 'lounge-chair', at: [x, 0, z] },
  { id: `${id}Person`, asset: 'seated-person', at: [x, 0, z] },
];
const stone = '#c3b9a3', timber = '#624738', brass = '#b69657';

export const REFERENCE_SCENES: readonly ReferenceScene[] = [
  {
    id: 'interior', title: 'The aquarium reading room',
    description: 'A warm reading room: glass aquarium, two seated visitors, walnut furniture and a framed doorway.',
    target: [0, 1.25, -0.5], cameras: [[9, 6.7, 12], [-8, 5, 11], [5, 3.2, 8], [-4, 3, 6]],
    background: '#b5c6ca', lamp: [-3.7, 2.9, -1],
    assets: [
      { id: 'aquarium', asset: 'aquarium', at: [-2.4, 0.92, -2.8], scale: 2.5 },
      ...seat('readerA', 0.8, -1.4), ...seat('readerB', 2.4, -1.4),
      { id: 'plantB', asset: 'potted-plant', at: [4, 0, 1.9], scale: 1.5 },
      { id: 'door', asset: 'panel-door', at: [2.6, 0, -3.85] },
    ],
    surfaces: [
      box('foundation', [0, -0.23, 0], [10, 0.45, 8], stone),
      ...Array.from({ length: 16 }, (_, i) => box(`plank${i}`, [0, -0.015, -3.75 + i * 0.5], [9.7, 0.035, 0.48], i % 2 ? '#9a7958' : '#af8e68')),
      box('backLeft', [-1.5, 1.7, -4], [7, 3.4, 0.22], '#d9d6c7'),
      box('backRight', [4.1, 1.7, -4], [1.8, 3.4, 0.22], '#d9d6c7'),
      box('doorLintel', [2.75, 2.85, -4], [1.5, 1.1, 0.22], '#d9d6c7'),
      box('sideWall', [-5, 1.7, -0.4], [0.22, 3.4, 7.2], '#c5c6b5'),
      box('wallCap', [-1.5, 3.4, -4], [7, 0.12, 0.3], timber),
      box('tankCabinet', [-2.4, 0.45, -2.8], [2.7, 0.9, 1.35], timber),
      ...[-3.05, -1.75].map((x, i) => box(`cabinetDoor${i}`, [x, 0.47, -2.115], [1.24, 0.7, 0.035], '#89674a')),
      box('rug', [1.6, 0.015, 0.15], [4.3, 0.025, 3.1], '#617e80'),
      box('coffeeTop', [1.6, 0.53, 0.8], [2.2, 0.13, 0.8], timber),
      ...[0.7, 2.5].map((x, i) => box(`tableLeg${i}`, [x, 0.25, 0.8], [0.12, 0.5, 0.6], '#393d39')),
      box('bookA', [1.1, 0.64, 0.8], [0.42, 0.08, 0.3], '#c5a361'),
      box('bookB', [1.9, 0.64, 0.8], [0.32, 0.08, 0.4], '#b87053'),
      cylinder('lampStem', [-3.7, 1.4, -1], 0.035, 2.8, brass),
      cylinder('lampFoot', [-3.7, 0.035, -1], 0.3, 0.07, brass),
    ],
  },
  {
    id: 'courtyard', title: 'The waterside courtyard',
    description: 'A sheltered promenade beside water, with a pergola, seating, planting and human scale.',
    target: [0, 1, -0.8], cameras: [[13, 8, 15], [-12, 7, 14], [9, 3.7, 10], [-7, 3, 8]],
    background: '#abc9d4', lamp: [3, 3.4, -2],
    assets: [...seat('visitorA', -2, -2), ...seat('visitorB', -0.6, -2),
      ...[-4, 4].map((x, i) => ({ id: `planter${i}`, asset: 'potted-plant', at: [x, 0.25, -3.5] as Vec3, scale: 1.8 }))],
    surfaces: [
      box('island', [0, -0.35, 0], [13, 0.7, 10], stone),
      { ...box('water', [0, -0.7, 0], [180, 0.12, 180], '#427d8d'), roughness: 0.24, metalness: 0.2 },
      box('distantBank', [0, -0.7, -22], [65, 1.3, 8], '#5f7770'),
      ...Array.from({ length: 9 }, (_, i) => box(`paver${i}`, [-5.6 + 1.4 * i, 0.02, 1.1], [1.34, 0.04, 6.3], i % 2 ? '#cfc4aa' : '#beb7a1')),
      ...[-4, 4].map((x, i) => box(`bed${i}`, [x, 0.12, -3.5], [1.8, 0.24, 1.8], '#a7a692')),
      ...[-3.4, 1.4].flatMap((x, i) => [-3.4, -0.1].map((z, j) => box(`post${i}${j}`, [x, 1.7, z], [0.18, 3.4, 0.18], timber))),
      ...[-3.4, -0.1].map((z, i) => box(`beam${i}`, [-1, 3.35, z], [5.4, 0.23, 0.22], timber)),
      ...Array.from({ length: 10 }, (_, i) => box(`louver${i}`, [-3.4 + i * 0.53, 3.55, -1.75], [0.13, 0.16, 4], '#9d8059')),
      box('quayEdge', [0, 0.08, -4.6], [13, 0.16, 0.45], '#d9ceb6'),
      ...Array.from({ length: 7 }, (_, i) => cylinder(`bollard${i}`, [-6 + i * 2, 0.52, -4.6], 0.065, 1, '#3f534d')),
      box('rail', [0, 1.05, -4.6], [12, 0.08, 0.08], '#3f534d'),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `hill${i}`, kind: 'sphere' as const, at: [-24 + i * 8, 0, -24] as Vec3, size: [7, 3 + (i % 3), 5] as Vec3, color: '#748b7b' })),
      cylinder('lightPole', [3, 1.7, -2], 0.06, 3.4, '#465651'),
    ],
  },
  {
    id: 'observatory', title: 'The tidal observatory',
    description: 'An open ring sanctuary above a stepped terrace; a custom twisted stone aperture forms its centre.',
    target: [0, 2.6, 0], cameras: [[13, 8.5, 17], [-13, 7, 16], [6, 4, 10], [-7, 3.8, 9]],
    background: '#879cae', lamp: [0, 3.3, 0],
    assets: [...seat('keeper', -3, 0.8), { id: 'fern', asset: 'potted-plant', at: [3.5, 0, 1.2], scale: 1.8 }],
    surfaces: [
      cylinder('terrace', [0, -0.3, 0], 6.7, 0.6, '#9daaa7'),
      cylinder('plinth', [0, 0.16, -0.5], 2.5, 0.32, '#b2bdb8'),
      { ...box('sea', [0, -1.1, 0], [180, 0.15, 180], '#376574'), roughness: 0.24, metalness: 0.2 },
      ...Array.from({ length: 5 }, (_, i) => box(`stair${i}`, [0, -0.09 - i * 0.15, 5.7 + i * 0.45], [3.5, 0.18, 0.6], stone)),
      ...Array.from({ length: 7 }, (_, i) => {
        const a = Math.PI + i * Math.PI / 6;
        return cylinder(`column${i}`, [5.3 * Math.cos(a), 2.4, 5.3 * Math.sin(a)], 0.22, 4.8, '#bfcec6');
      }),
      { id: 'crown', kind: 'torus', at: [0, 4.85, 0], size: [5.3, 0.18, 1], color: brass, metalness: 0.65 },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `marker${i}`, kind: 'sphere' as const, at: [-18 + i * 10, -0.5, -18 - (i % 2) * 5] as Vec3, size: [2.4, 4 + i % 3, 2.4] as Vec3, color: '#66818a' })),
    ],
    shape: {
      shapeId: 'twistedAperture', stableId: 'aperture', nodes: [
        { kind: 'torus', majorRadius: 1.6, minorRadius: 0.32 },
        { kind: 'rotate', child: 0, yaw: 0, pitch: Math.PI / 2, roll: 0 },
        { kind: 'twist', child: 1, axis: 'y', radiansPerUnit: 0.65 },
        { kind: 'translate', child: 2, offset: [0, 2.3, 0] },
      ], root: 3, targetBounds: { min: [-2, 0.3, -2], max: [2, 4.3, 2] },
      anchors: [], materialIntent: 'sandstone', priority: 1,
    },
  },
];

export function referenceBlueprint(scene: ReferenceScene, layout = false) {
  const objects = scene.assets.map((instance, index) => {
    const asset = catalog.assets.find(entry => entry.assetId === instance.asset)!;
    const at = layout ? [(index % 4 - 1.5) * 2, 0, Math.floor(index / 4) * 2 - 2] : instance.at;
    const bounds = { min: asset.bounds.min.map((v, axis) => v * (instance.scale ?? 1) + at[axis]),
      max: asset.bounds.max.map((v, axis) => v * (instance.scale ?? 1) + at[axis]) };
    return { stableId: instance.id, label: asset.label, synonyms: [], role: 'prop', importance: 2,
      source: { kind: 'asset', assetId: asset.assetId, version: asset.version, hash: asset.hash },
      targetBounds: bounds, binding: { collider: bounds, sockets: [], parts: [] } };
  });
  return blueprintSchema.parse({ ...DEMO_BLUEPRINT, version: 'worldstream-v2', title: scene.title,
    geometry: { ...DEMO_BLUEPRINT.geometry, nodes: [{ kind: 'terrain', variant: 'ridge', extent: [1, 1], amplitude: 0, seed: 1 }], root: 0 },
    objects: [...objects, ...(scene.shape ? [{ stableId: 'aperture', label: 'Twisted aperture', synonyms: [], role: 'hero', importance: 3,
      source: { kind: 'shape', shapeId: scene.shape.shapeId }, targetBounds: scene.shape.targetBounds }] : [])],
    shapes: scene.shape ? [scene.shape] : [],
  });
}
