import { BoxGeometry, CylinderGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/** Svislé nosné prvky. Osm radiálních segmentů je strop stylizace i rozpočtu. */
export const columnPieces: readonly Piece[] = [
  {
    id: 'column.pillar',
    category: 'column',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.22, 0.26, 2, 8), swatch: 'shell' },
        { geometry: new BoxGeometry(0.62, 0.14, 0.62), swatch: 'deep', position: [0, -0.97, 0] },
      ]),
  },
  {
    id: 'column.capital',
    category: 'column',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.2, 0.24, 1.7, 8), swatch: 'shell', position: [0, -0.1, 0] },
        { geometry: new BoxGeometry(0.62, 0.16, 0.62), swatch: 'sand', position: [0, 0.83, 0] },
        { geometry: new BoxGeometry(0.7, 0.12, 0.7), swatch: 'deep', position: [0, -0.99, 0] },
      ]),
  },
  {
    id: 'column.fluted',
    category: 'column',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.2, 0.2, 2, 8), swatch: 'shell' },
        {
          geometry: new BoxGeometry(0.06, 1.8, 0.5),
          swatch: 'deep',
          rotation: [0, Math.PI / 6, 0],
        },
        {
          geometry: new BoxGeometry(0.06, 1.8, 0.5),
          swatch: 'deep',
          rotation: [0, -Math.PI / 6, 0],
        },
      ]),
  },
  {
    id: 'column.post',
    category: 'column',
    build: () => assemble([{ geometry: new BoxGeometry(0.16, 1.6, 0.16), swatch: 'deep' }]),
  },
  {
    id: 'column.twisted',
    category: 'column',
    build: () =>
      assemble(
        [0, 1, 2, 3].map((i) => ({
          geometry: new BoxGeometry(0.32, 0.5, 0.32),
          swatch: i % 2 === 0 ? ('shell' as const) : ('sand' as const),
          position: [0, -0.75 + i * 0.5, 0] as const,
          rotation: [0, i * 0.36, 0] as const,
        })),
      ),
  },
  {
    id: 'column.broken',
    category: 'column',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.22, 0.26, 1.1, 8), swatch: 'shell', position: [0, -0.45, 0] },
        {
          geometry: new CylinderGeometry(0.2, 0.22, 0.3, 8),
          swatch: 'shell',
          position: [0.06, 0.24, 0.04],
          rotation: [0.22, 0, 0.14],
        },
        { geometry: new BoxGeometry(0.62, 0.14, 0.62), swatch: 'deep', position: [0, -1.05, 0] },
      ]),
  },
];
