import { BoxGeometry, CylinderGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/** Plné hmoty — základ terénu a zástavby. Jednotka je 1 = jedno pole mřížky. */
export const massPieces: readonly Piece[] = [
  {
    id: 'mass.block',
    category: 'mass',
    build: () => assemble([{ geometry: new BoxGeometry(1, 1, 1), swatch: 'shell' }]),
  },
  {
    id: 'mass.wedge',
    category: 'mass',
    build: () =>
      assemble([
        {
          // Trojboký hranol = válec o třech radiálních segmentech. Levnější než
          // ruční buffer a vyjde z něj přesná rampa.
          geometry: new CylinderGeometry(0.72, 0.72, 1, 3),
          swatch: 'shell',
          rotation: [Math.PI / 2, 0, Math.PI / 6],
        },
      ]),
  },
  {
    id: 'mass.step',
    category: 'mass',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.34, 1), swatch: 'shell', position: [0, -0.33, 0] },
        { geometry: new BoxGeometry(1, 0.34, 0.66), swatch: 'shell', position: [0, 0.01, -0.17] },
        { geometry: new BoxGeometry(1, 0.34, 0.33), swatch: 'deep', position: [0, 0.35, -0.34] },
      ]),
  },
  {
    id: 'mass.plinth',
    category: 'mass',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1.2, 0.22, 1.2), swatch: 'deep', position: [0, -0.39, 0] },
        { geometry: new BoxGeometry(0.9, 0.56, 0.9), swatch: 'shell', position: [0, 0, 0] },
        { geometry: new BoxGeometry(1.1, 0.16, 1.1), swatch: 'deep', position: [0, 0.36, 0] },
      ]),
  },
  {
    id: 'mass.stack',
    category: 'mass',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.4, 1), swatch: 'shell', position: [0, -0.3, 0] },
        {
          geometry: new BoxGeometry(0.82, 0.36, 0.82),
          swatch: 'sand',
          position: [0, 0.08, 0],
          rotation: [0, 0.28, 0],
        },
        {
          geometry: new BoxGeometry(0.6, 0.3, 0.6),
          swatch: 'shell',
          position: [0, 0.41, 0],
          rotation: [0, -0.34, 0],
        },
      ]),
  },
  {
    id: 'mass.bevel',
    category: 'mass',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.7, 1), swatch: 'shell', position: [0, -0.15, 0] },
        {
          geometry: new CylinderGeometry(0.72, 0.72, 1, 4),
          swatch: 'shell',
          position: [0, 0.34, 0],
          rotation: [0, Math.PI / 4, 0],
          scale: [1, 0.3, 1],
        },
      ]),
  },
];
