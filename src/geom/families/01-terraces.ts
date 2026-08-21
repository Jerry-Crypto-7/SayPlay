import { GEOM_VERSION, type GeomProgram } from '../program';

import { familyStream, nextInt, type Family } from './family';

/**
 * Terasy — široká, nízká krajina odstupňovaných desek.
 *
 * Silueta leží: nic nepřesáhne pár polí nad zem a scéna se roztahuje do stran.
 * Je to protipól **Věží**, se kterými se měří odlišnost profilu.
 */
export const terraces: Family = {
  id: 'terraces',
  title: 'Terasy',
  palette: 'dunes',
  silhouette: 'stupně a desky, vodorovné pásy, nic vysokého',
  proportions: { footprint: 20, height: 4, pieces: 30 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    const steps = nextInt(stream, 6, 8);
    const plinths = nextInt(stream, 8, 12);
    const decks = nextInt(stream, 3, 5);

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'plateau',
          extent: [40, 40],
          amplitude: 2,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'mass', variant: 'step', at: [-9, 0, -6], scale: [2, 1, 2] },
        { kind: 'repeat', child: 1, count: steps, step: [3, 0.34, 0] },
        { kind: 'mirror', child: 2, axis: 'z' },
        { kind: 'mass', variant: 'plinth', scale: [1.6, 0.6, 1.6] },
        {
          kind: 'scatter',
          child: 4,
          count: plinths,
          radius: 16,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'panel', variant: 'floor', at: [-6, 0.6, 8], scale: [3, 1, 3] },
        { kind: 'repeat', child: 6, count: decks, step: [4, 0, 0] },
        { kind: 'group', children: [0, 3, 5, 7] },
      ],
      root: 8,
    };
  },
};
