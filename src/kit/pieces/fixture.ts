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
];
