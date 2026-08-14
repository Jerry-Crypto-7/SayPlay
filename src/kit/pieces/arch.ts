import { BoxGeometry, CylinderGeometry, TorusGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/** Průchody a rámy. Nesou průchodnost layoutu, takže mají otvor na celý kus. */
export const archPieces: readonly Piece[] = [
  {
    id: 'arch.round',
    category: 'arch',
    build: () =>
      assemble([
        {
          geometry: new TorusGeometry(0.52, 0.13, 4, 10, Math.PI),
          swatch: 'shell',
          position: [0, 0.24, 0],
        },
        { geometry: new BoxGeometry(0.26, 0.9, 0.26), swatch: 'shell', position: [-0.52, -0.21, 0] },
        { geometry: new BoxGeometry(0.26, 0.9, 0.26), swatch: 'shell', position: [0.52, -0.21, 0] },
      ]),
  },
  {
    id: 'arch.flat',
    category: 'arch',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1.4, 0.24, 0.3), swatch: 'shell', position: [0, 0.68, 0] },
        { geometry: new BoxGeometry(0.24, 1.4, 0.3), swatch: 'shell', position: [-0.58, -0.14, 0] },
        { geometry: new BoxGeometry(0.24, 1.4, 0.3), swatch: 'shell', position: [0.58, -0.14, 0] },
      ]),
  },
  {
    id: 'arch.doorway',
    category: 'arch',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1.5, 0.22, 0.36), swatch: 'deep', position: [0, 0.8, 0] },
        { geometry: new BoxGeometry(0.22, 1.6, 0.36), swatch: 'deep', position: [-0.64, -0.1, 0] },
        { geometry: new BoxGeometry(0.22, 1.6, 0.36), swatch: 'deep', position: [0.64, -0.1, 0] },
        { geometry: new BoxGeometry(1.5, 0.14, 0.5), swatch: 'sand', position: [0, -0.86, 0] },
      ]),
  },
  {
    id: 'arch.portal',
    category: 'arch',
    build: () =>
      assemble([
        {
          geometry: new TorusGeometry(0.62, 0.1, 4, 12),
          swatch: 'accent',
          position: [0, 0.3, 0],
        },
        { geometry: new BoxGeometry(0.9, 0.18, 0.4), swatch: 'deep', position: [0, -0.5, 0] },
        { geometry: new BoxGeometry(0.2, 0.5, 0.2), swatch: 'deep', position: [0, -0.78, 0] },
      ]),
  },
  {
    id: 'arch.buttress',
    category: 'arch',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.3, 1.6, 0.3), swatch: 'shell', position: [-0.42, 0, 0] },
        {
          geometry: new CylinderGeometry(0.5, 0.5, 0.26, 3),
          swatch: 'shell',
          position: [0.16, 0.16, 0],
          rotation: [Math.PI / 2, 0, -Math.PI / 6],
        },
        { geometry: new BoxGeometry(0.5, 0.2, 0.4), swatch: 'deep', position: [0.32, -0.7, 0] },
      ]),
  },
];
