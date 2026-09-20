import { BoxGeometry, ConeGeometry, CylinderGeometry, IcosahedronGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/** Interaktivní i dekorační drobnosti. Hry z Fáze B je používají jako cíle. */
export const fixturePieces: readonly Piece[] = [
  {
    id: 'fixture.crate',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.6, 0.6, 0.6), swatch: 'warm' },
        { geometry: new BoxGeometry(0.66, 0.08, 0.08), swatch: 'deep', position: [0, 0.2, 0] },
        { geometry: new BoxGeometry(0.08, 0.08, 0.66), swatch: 'deep', position: [0, 0.2, 0] },
      ]),
  },
  {
    id: 'fixture.barrel',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.26, 0.26, 0.7, 8), swatch: 'warm' },
        { geometry: new CylinderGeometry(0.28, 0.28, 0.06, 8), swatch: 'deep', position: [0, 0.18, 0] },
        { geometry: new CylinderGeometry(0.28, 0.28, 0.06, 8), swatch: 'deep', position: [0, -0.18, 0] },
      ]),
  },
  {
    id: 'fixture.lamp',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.06, 0.09, 1.6, 6), swatch: 'deep', position: [0, -0.1, 0] },
        { geometry: new ConeGeometry(0.24, 0.3, 8), swatch: 'shell', position: [0, 0.78, 0] },
        { geometry: new IcosahedronGeometry(0.13, 0), swatch: 'accent', position: [0, 0.6, 0] },
      ]),
  },
  {
    id: 'fixture.sign',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.08, 1.1, 0.08), swatch: 'deep', position: [0, -0.3, 0] },
        { geometry: new BoxGeometry(0.72, 0.44, 0.06), swatch: 'sand', position: [0, 0.42, 0] },
        { geometry: new BoxGeometry(0.58, 0.08, 0.09), swatch: 'deep', position: [0, 0.5, 0] },
      ]),
  },
  {
    id: 'fixture.terminal',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.5, 0.9, 0.3), swatch: 'deep', position: [0, -0.05, 0] },
        {
          geometry: new BoxGeometry(0.42, 0.3, 0.06),
          swatch: 'accent',
          position: [0, 0.22, 0.16],
          rotation: [-0.3, 0, 0],
        },
        { geometry: new BoxGeometry(0.6, 0.08, 0.4), swatch: 'shell', position: [0, -0.46, 0] },
      ]),
  },
  {
    id: 'fixture.hatch',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.44, 0.44, 0.1, 8), swatch: 'deep' },
        { geometry: new CylinderGeometry(0.3, 0.3, 0.14, 8), swatch: 'shell', position: [0, 0.05, 0] },
        { geometry: new BoxGeometry(0.5, 0.06, 0.1), swatch: 'warm', position: [0, 0.13, 0] },
      ]),
  },
  {
    id: 'fixture.pipe',
    category: 'fixture',
    build: () =>
      assemble([
        {
          geometry: new CylinderGeometry(0.13, 0.13, 1.3, 6),
          swatch: 'shell',
          rotation: [0, 0, Math.PI / 2],
        },
        { geometry: new CylinderGeometry(0.17, 0.17, 0.12, 6), swatch: 'deep', position: [-0.45, 0, 0], rotation: [0, 0, Math.PI / 2] },
        { geometry: new CylinderGeometry(0.17, 0.17, 0.12, 6), swatch: 'deep', position: [0.45, 0, 0], rotation: [0, 0, Math.PI / 2] },
      ]),
  },
  {
    id: 'fixture.bench',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.1, 0.34), swatch: 'sand', position: [0, 0.14, 0] },
        { geometry: new BoxGeometry(0.1, 0.36, 0.3), swatch: 'deep', position: [-0.38, -0.1, 0] },
        { geometry: new BoxGeometry(0.1, 0.36, 0.3), swatch: 'deep', position: [0.38, -0.1, 0] },
      ]),
  },
  // P19 T6: kusy, podle kterých se místnost pozná – čekárna, chata, obchod,
  // ordinace. Přední strana míří +Z jako u herců.
  {
    id: 'fixture.aquarium',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.5, 0.42), swatch: 'deep', position: [0, -0.3, 0] },
        { geometry: new BoxGeometry(0.96, 0.52, 0.38), swatch: 'accent', position: [0, 0.21, 0] },
        { geometry: new BoxGeometry(1.02, 0.05, 0.44), swatch: 'deep', position: [0, 0.49, 0] },
        { geometry: new BoxGeometry(0.94, 0.06, 0.36), swatch: 'sand', position: [0, -0.02, 0] },
        { geometry: new ConeGeometry(0.06, 0.26, 8), swatch: 'moss', position: [-0.32, 0.14, 0] },
        { geometry: new ConeGeometry(0.05, 0.2, 8), swatch: 'moss', position: [0.34, 0.11, -0.06] },
        { geometry: new BoxGeometry(0.12, 0.06, 0.03), swatch: 'warm', position: [-0.06, 0.28, 0.2] },
        { geometry: new BoxGeometry(0.1, 0.05, 0.03), swatch: 'warm', position: [0.18, 0.16, 0.2] },
      ]),
  },
  {
    id: 'fixture.fireplace',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1.3, 0.9, 0.46), swatch: 'shell', position: [0, -0.2, 0] },
        { geometry: new BoxGeometry(0.7, 0.52, 0.08), swatch: 'deep', position: [0, -0.35, 0.2] },
        { geometry: new BoxGeometry(1.5, 0.08, 0.56), swatch: 'sand', position: [0, 0.28, 0.03] },
        { geometry: new BoxGeometry(0.8, 0.9, 0.36), swatch: 'shell', position: [0, 0.77, -0.05] },
        { geometry: new ConeGeometry(0.14, 0.34, 8), swatch: 'warm', position: [-0.1, -0.44, 0.24] },
        { geometry: new ConeGeometry(0.1, 0.26, 8), swatch: 'warm', position: [0.12, -0.48, 0.24] },
        { geometry: new BoxGeometry(0.5, 0.06, 0.1), swatch: 'deep', position: [0, -0.62, 0.26] },
      ]),
  },
  {
    id: 'fixture.checkout',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1.6, 0.8, 0.6), swatch: 'shell', position: [0, -0.2, 0] },
        { geometry: new BoxGeometry(1.2, 0.05, 0.46), swatch: 'deep', position: [-0.14, 0.225, 0] },
        { geometry: new CylinderGeometry(0.03, 0.03, 0.48, 8), swatch: 'shell', position: [-0.74, 0.23, 0], rotation: [Math.PI / 2, 0, 0] },
        { geometry: new BoxGeometry(0.02, 0.06, 0.4), swatch: 'warm', position: [0.1, 0.28, 0] },
        { geometry: new BoxGeometry(0.34, 0.16, 0.3), swatch: 'deep', position: [0.6, 0.28, -0.08] },
        { geometry: new BoxGeometry(0.28, 0.2, 0.04), swatch: 'accent', position: [0.6, 0.48, -0.16], rotation: [-0.25, 0, 0] },
        { geometry: new CylinderGeometry(0.03, 0.03, 0.9, 8), swatch: 'deep', position: [0.76, 0.65, -0.26] },
        { geometry: new BoxGeometry(0.26, 0.2, 0.06), swatch: 'accent', position: [0.76, 1.1, -0.26] },
      ]),
  },
  {
    id: 'fixture.couch',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1.8, 0.14, 0.62), swatch: 'accent', position: [0, 0.2, 0] },
        { geometry: new BoxGeometry(0.46, 0.12, 0.6), swatch: 'accent', position: [-0.72, 0.36, 0], rotation: [0, 0, -0.35] },
        { geometry: new BoxGeometry(1.6, 0.03, 0.4), swatch: 'shell', position: [0.1, 0.285, 0] },
        { geometry: new CylinderGeometry(0.08, 0.08, 0.5, 8), swatch: 'shell', position: [-0.98, 0.2, 0], rotation: [Math.PI / 2, 0, 0] },
        { geometry: new BoxGeometry(0.06, 0.4, 0.06), swatch: 'deep', position: [-0.8, -0.07, -0.26] },
        { geometry: new BoxGeometry(0.06, 0.4, 0.06), swatch: 'deep', position: [-0.8, -0.07, 0.26] },
        { geometry: new BoxGeometry(0.06, 0.4, 0.06), swatch: 'deep', position: [0.8, -0.07, -0.26] },
        { geometry: new BoxGeometry(0.06, 0.4, 0.06), swatch: 'deep', position: [0.8, -0.07, 0.26] },
      ]),
  },
  {
    id: 'fixture.reception',
    category: 'fixture',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(2, 1.05, 0.5), swatch: 'warm' },
        { geometry: new BoxGeometry(2.1, 0.05, 0.4), swatch: 'sand', position: [0, 0.55, 0.12] },
        { geometry: new BoxGeometry(1.7, 0.4, 0.04), swatch: 'accent', position: [0, 0.1, 0.27] },
        { geometry: new BoxGeometry(0.5, 1.05, 1.1), swatch: 'warm', position: [0.95, 0, -0.55] },
        { geometry: new BoxGeometry(0.44, 0.3, 0.04), swatch: 'deep', position: [-0.4, 0.72, -0.12] },
        { geometry: new BoxGeometry(0.08, 0.16, 0.08), swatch: 'deep', position: [-0.4, 0.6, -0.14] },
        { geometry: new BoxGeometry(0.9, 0.08, 0.2), swatch: 'shell', position: [0, 0.3, 0.3] },
      ]),
  },
];
