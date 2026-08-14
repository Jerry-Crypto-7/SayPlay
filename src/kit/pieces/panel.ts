import { BoxGeometry, CylinderGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/** Ploché dělicí a pochozí prvky. Tloušťka je sdílená, aby na sebe navazovaly. */
export const panelPieces: readonly Piece[] = [
  {
    id: 'panel.wall',
    category: 'panel',
    build: () => assemble([{ geometry: new BoxGeometry(1, 1.6, 0.16), swatch: 'shell' }]),
  },
  {
    id: 'panel.half',
    category: 'panel',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.7, 0.16), swatch: 'shell', position: [0, -0.1, 0] },
        { geometry: new BoxGeometry(1.06, 0.1, 0.24), swatch: 'deep', position: [0, 0.3, 0] },
      ]),
  },
  {
    id: 'panel.floor',
    category: 'panel',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.12, 1), swatch: 'sand' },
        { geometry: new BoxGeometry(0.84, 0.02, 0.84), swatch: 'deep', position: [0, 0.07, 0] },
      ]),
  },
  {
    id: 'panel.ramp',
    category: 'panel',
    build: () =>
      assemble([
        {
          geometry: new BoxGeometry(1, 0.14, 1.5),
          swatch: 'sand',
          rotation: [-0.36, 0, 0],
        },
        { geometry: new BoxGeometry(1, 0.1, 0.3), swatch: 'deep', position: [0, -0.28, 0.66] },
      ]),
  },
  {
    id: 'panel.railing',
    category: 'panel',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.08, 0.08), swatch: 'deep', position: [0, 0.4, 0] },
        { geometry: new BoxGeometry(1, 0.06, 0.06), swatch: 'deep', position: [0, 0.1, 0] },
        { geometry: new BoxGeometry(0.09, 0.9, 0.09), swatch: 'deep', position: [-0.44, 0, 0] },
        { geometry: new BoxGeometry(0.09, 0.9, 0.09), swatch: 'deep', position: [0.44, 0, 0] },
      ]),
  },
  {
    id: 'panel.window',
    category: 'panel',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(1, 0.44, 0.16), swatch: 'shell', position: [0, 0.58, 0] },
        { geometry: new BoxGeometry(1, 0.44, 0.16), swatch: 'shell', position: [0, -0.58, 0] },
        { geometry: new BoxGeometry(0.24, 0.72, 0.16), swatch: 'shell', position: [-0.38, 0, 0] },
        { geometry: new BoxGeometry(0.24, 0.72, 0.16), swatch: 'shell', position: [0.38, 0, 0] },
        { geometry: new BoxGeometry(0.56, 0.72, 0.04), swatch: 'accent', position: [0, 0, 0] },
      ]),
  },
  {
    id: 'panel.roof',
    category: 'panel',
    build: () =>
      assemble([
        {
          geometry: new CylinderGeometry(0.78, 0.78, 1.2, 3),
          swatch: 'warm',
          rotation: [Math.PI / 2, 0, Math.PI / 2],
          scale: [1, 1, 0.5],
        },
        { geometry: new BoxGeometry(1.3, 0.1, 1.3), swatch: 'deep', position: [0, -0.38, 0] },
      ]),
  },
];
