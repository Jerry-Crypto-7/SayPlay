import { GEOM_VERSION, type GeomProgram } from '../program';

import { familyStream, nextInt, type Family } from './family';

/**
 * Háj — pánev zarostlá porostem, žádná stavba.
 *
 * Silueta je rozdrobená: scénu nese výhradně kategorie `organic`, takže
 * v profilu nejsou svislé ani vodorovné pásy, ale shluky. Paleta je zelená,
 * což ji od zbylých tří rodin odděluje i barvou.
 */
export const grove: Family = {
  id: 'grove',
  title: 'Háj',
  palette: 'thicket',
  silhouette: 'porost ve shlucích, žádná rovná hrana, žádná stavba',
  proportions: { footprint: 20, height: 6, pieces: 66 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    const trees = nextInt(stream, 18, 22);
    const shrubs = nextInt(stream, 20, 24);
    const boulders = nextInt(stream, 7, 9);
    const reeds = nextInt(stream, 14, 18);

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'basin',
          extent: [44, 44],
          amplitude: 3,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'organic', variant: 'tree', scale: [1.4, 1.8, 1.4] },
        { kind: 'scatter', child: 1, count: trees, radius: 17, seed: nextInt(stream, 0, 100_000) },
        { kind: 'organic', variant: 'shrub' },
        { kind: 'scatter', child: 3, count: shrubs, radius: 19, seed: nextInt(stream, 0, 100_000) },
        { kind: 'organic', variant: 'boulder', scale: [1.6, 1.2, 1.6] },
        { kind: 'scatter', child: 5, count: boulders, radius: 14, seed: nextInt(stream, 0, 100_000) },
        { kind: 'organic', variant: 'reed' },
        { kind: 'scatter', child: 7, count: reeds, radius: 20, seed: nextInt(stream, 0, 100_000) },
        { kind: 'group', children: [0, 2, 4, 6, 8] },
      ],
      root: 9,
    };
  },
};
