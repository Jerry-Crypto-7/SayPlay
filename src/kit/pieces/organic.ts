import { ConeGeometry, CylinderGeometry, IcosahedronGeometry } from 'three';

import { assemble, type Piece } from './primitives';

/**
 * Přírodní tvary. Vždy `IcosahedronGeometry` s detailem 0 — vyšší detail dělá
 * kouli, ne kámen, a ploché normály z něj vypadají jako chyba.
 */
export const organicPieces: readonly Piece[] = [
  {
    id: 'organic.pebble',
    category: 'organic',
    build: () =>
      assemble([
        {
          geometry: new IcosahedronGeometry(0.28, 0),
          swatch: 'shell',
          rotation: [0.3, 0.7, 0.2],
          scale: [1, 0.66, 1.1],
        },
      ]),
  },
  {
    id: 'organic.boulder',
    category: 'organic',
    build: () =>
      assemble([
        {
          geometry: new IcosahedronGeometry(0.6, 0),
          swatch: 'shell',
          rotation: [0.5, 0.2, 0.4],
          scale: [1.2, 0.8, 1],
        },
      ]),
  },
  {
    id: 'organic.cluster',
    category: 'organic',
    build: () =>
      assemble([
        {
          geometry: new IcosahedronGeometry(0.4, 0),
          swatch: 'shell',
          position: [-0.2, -0.1, 0.1],
          rotation: [0.2, 0.9, 0.1],
        },
        {
          geometry: new IcosahedronGeometry(0.28, 0),
          swatch: 'deep',
          position: [0.26, -0.2, -0.14],
          rotation: [0.7, 0.2, 0.5],
        },
        {
          geometry: new IcosahedronGeometry(0.2, 0),
          swatch: 'sand',
          position: [0.04, -0.3, 0.3],
          rotation: [0.4, 0.5, 0.9],
        },
      ]),
  },
  {
    id: 'organic.shrub',
    category: 'organic',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.05, 0.07, 0.3, 5), swatch: 'warm', position: [0, -0.34, 0] },
        {
          geometry: new IcosahedronGeometry(0.34, 0),
          swatch: 'moss',
          position: [0, -0.02, 0],
          scale: [1.1, 0.8, 1.1],
        },
      ]),
  },
  {
    id: 'organic.tree',
    category: 'organic',
    build: () =>
      assemble([
        { geometry: new CylinderGeometry(0.09, 0.14, 1.1, 6), swatch: 'warm', position: [0, -0.45, 0] },
        { geometry: new ConeGeometry(0.52, 0.7, 7), swatch: 'moss', position: [0, 0.28, 0] },
        { geometry: new ConeGeometry(0.38, 0.56, 7), swatch: 'moss', position: [0, 0.66, 0] },
      ]),
  },
  {
    id: 'organic.reed',
    category: 'organic',
    build: () =>
      assemble([
        {
          geometry: new CylinderGeometry(0.03, 0.05, 1, 4),
          swatch: 'moss',
          position: [-0.12, 0, 0],
          rotation: [0, 0, 0.14],
        },
        {
          geometry: new CylinderGeometry(0.03, 0.05, 1.3, 4),
          swatch: 'moss',
          position: [0.04, 0.14, 0.06],
          rotation: [0.1, 0, -0.06],
        },
        {
          geometry: new CylinderGeometry(0.03, 0.04, 0.8, 4),
          swatch: 'sand',
          position: [0.18, -0.1, -0.08],
          rotation: [0, 0, -0.2],
        },
      ]),
  },
];
