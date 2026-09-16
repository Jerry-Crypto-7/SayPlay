import { BoxGeometry, ConeGeometry, CylinderGeometry, IcosahedronGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/**
 * Siluety postav a jednotek. Kit je nese v jedné pozici a bez rigu — animace
 * je věc hry, ne kusu. Všechny míří **+Z**, aby se natočení nemuselo hledat
 * u každého zvlášť (`REUSE.md`: normalizace, kterou u 40 kusů objevíš pozdě).
 */
export const actorPieces: readonly Piece[] = [
  {
    id: 'actor.tall',
    category: 'actor',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.18, 0.24, 0.9, 6), swatch: 'accent', position: [0, -0.1, 0] },
        { geometry: new IcosahedronGeometry(0.19, 0), swatch: 'sand', position: [0, 0.48, 0] },
        { geometry: new BoxGeometry(0.16, 0.1, 0.22), swatch: 'deep', position: [0, 0.46, 0.16] },
      ]),
  },
  {
    id: 'actor.squat',
    category: 'actor',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.52, 0.46, 0.42), swatch: 'warm', position: [0, -0.12, 0] },
        { geometry: new IcosahedronGeometry(0.21, 0), swatch: 'sand', position: [0, 0.26, 0.04] },
        { geometry: new BoxGeometry(0.14, 0.3, 0.14), swatch: 'deep', position: [-0.32, -0.16, 0] },
        { geometry: new BoxGeometry(0.14, 0.3, 0.14), swatch: 'deep', position: [0.32, -0.16, 0] },
      ]),
  },
  {
    id: 'actor.drone',
    category: 'actor',
    build: () =>
      assemble([
        { geometry: new IcosahedronGeometry(0.26, 0), swatch: 'deep', scale: [1.2, 0.8, 1.2] },
        { geometry: new ConeGeometry(0.1, 0.2, 6), swatch: 'accent', position: [0, 0, 0.28], rotation: [Math.PI / 2, 0, 0] },
        { geometry: new CylinderGeometry(0.04, 0.04, 0.3, 4), swatch: 'shell', position: [0, 0.2, 0] },
      ]),
  },
  {
    id: 'actor.quadruped',
    category: 'actor',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.34, 0.3, 0.72), swatch: 'moss', position: [0, 0.06, 0] },
        { geometry: new IcosahedronGeometry(0.17, 0), swatch: 'moss', position: [0, 0.14, 0.44] },
        { geometry: new BoxGeometry(0.09, 0.34, 0.09), swatch: 'deep', position: [-0.12, -0.25, 0.24] },
        { geometry: new BoxGeometry(0.09, 0.34, 0.09), swatch: 'deep', position: [0.12, -0.25, 0.24] },
        { geometry: new BoxGeometry(0.09, 0.34, 0.09), swatch: 'deep', position: [-0.12, -0.25, -0.24] },
        { geometry: new BoxGeometry(0.09, 0.34, 0.09), swatch: 'deep', position: [0.12, -0.25, -0.24] },
      ]),
  },
  // P19 T6: posluchač ve třídě, pacient v čekárně. Sed je pozice, ne animace,
  // takže je to vlastní kus i se židlí – bez ní by postava visela ve vzduchu.
  {
    id: 'actor.seated',
    category: 'actor',
    build: () =>
      assemble([
        { geometry: new BoxGeometry(0.48, 0.06, 0.46), swatch: 'deep', position: [0, -0.1, 0] },
        { geometry: new BoxGeometry(0.48, 0.5, 0.06), swatch: 'deep', position: [0, 0.18, -0.22] },
        { geometry: new BoxGeometry(0.05, 0.34, 0.05), swatch: 'deep', position: [-0.2, -0.3, 0.18] },
        { geometry: new BoxGeometry(0.05, 0.34, 0.05), swatch: 'deep', position: [0.2, -0.3, 0.18] },
        { geometry: new BoxGeometry(0.05, 0.34, 0.05), swatch: 'deep', position: [-0.2, -0.3, -0.18] },
        { geometry: new BoxGeometry(0.05, 0.34, 0.05), swatch: 'deep', position: [0.2, -0.3, -0.18] },
        { geometry: new CylinderGeometry(0.16, 0.2, 0.5, 6), swatch: 'accent', position: [0, 0.2, -0.06] },
        { geometry: new IcosahedronGeometry(0.17, 0), swatch: 'sand', position: [0, 0.6, -0.04] },
        { geometry: new BoxGeometry(0.3, 0.12, 0.38), swatch: 'accent', position: [0, -0.02, 0.14] },
        { geometry: new BoxGeometry(0.28, 0.34, 0.1), swatch: 'shell', position: [0, -0.24, 0.3] },
      ]),
  },
];
