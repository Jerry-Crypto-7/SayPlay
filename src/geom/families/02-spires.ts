import { GEOM_VERSION, type GeomProgram } from '../program';

import { familyStream, nextInt, type Family } from './family';

/**
 * Věže — úzká, vysoká zástavba na hřebeni.
 *
 * Silueta stojí: sloupy se skládají na sebe a scéna má několikrát větší výšku
 * než půdorys. Je to protipól **Teras**, se kterými se měří odlišnost profilu.
 */
export const spires: Family = {
  id: 'spires',
  title: 'Věže',
  palette: 'frost',
  silhouette: 'sloupy na sobě, svislé pásy, brána vysoko nad zemí',
  proportions: { footprint: 12, height: 18, pieces: 32 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    const floors = nextInt(stream, 4, 5);
    const towers = nextInt(stream, 3, 4);
    const outliers = nextInt(stream, 5, 7);

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'ridge',
          extent: [26, 26],
          amplitude: 5,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'column', variant: 'pillar', at: [-6, 2, 0], scale: [1, 4, 1] },
        { kind: 'repeat', child: 1, count: floors, step: [0, 3.9, 0] },
        { kind: 'repeat', child: 2, count: towers, step: [4, 0, 0] },
        { kind: 'mirror', child: 3, axis: 'z', about: 2 },
        { kind: 'arch', variant: 'portal', at: [0, 15, 1], scale: [1.6, 1.6, 1.6] },
        { kind: 'column', variant: 'twisted', at: [0, 1.5, 0], scale: [1, 3, 1] },
        {
          kind: 'scatter',
          child: 6,
          count: outliers,
          radius: 10,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'group', children: [0, 4, 5, 7] },
      ],
      root: 8,
    };
  },
};
