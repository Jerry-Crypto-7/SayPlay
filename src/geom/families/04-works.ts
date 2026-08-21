import { GEOM_VERSION, type GeomProgram } from '../program';

import { familyStream, nextInt, type Family } from './family';

/**
 * Hutě — hranaté haly na rovině, prosekané průchody.
 *
 * Silueta je pravoúhlá a opakovaná: stěny stojí v řadách, mezi nimi jsou díry
 * vyseknuté `carve`. Je to jediná rodina, která `carve` používá jako výtvarný
 * prostředek, a jediná s oranžovým akcentem palety `foundry`.
 */
export const works: Family = {
  id: 'works',
  title: 'Hutě',
  palette: 'foundry',
  silhouette: 'řady stěn s prosekanými průchody, hranaté bloky, rovná zem',
  proportions: { footprint: 18, height: 6, pieces: 36 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    const bays = nextInt(stream, 7, 9);
    const halls = nextInt(stream, 3, 4);
    const blocks = nextInt(stream, 4, 6);

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'flat',
          extent: [36, 36],
          amplitude: 0.5,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'panel', variant: 'wall', at: [-8, 1, -6], scale: [1, 2, 1] },
        { kind: 'repeat', child: 1, count: bays, step: [1, 0, 0] },
        { kind: 'carve', child: 2, at: [-5, 1, -6], size: [1.2, 2.4, 3] },
        { kind: 'repeat', child: 3, count: halls, step: [0, 0, 6] },
        { kind: 'mass', variant: 'block', at: [-6, 0.7, 10], scale: [2, 1.4, 2] },
        { kind: 'repeat', child: 5, count: blocks, step: [3.4, 0, 0] },
        { kind: 'arch', variant: 'flat', at: [0, 0, -12], scale: [1.8, 1.8, 1.8] },
        { kind: 'group', children: [0, 4, 6, 7] },
      ],
      root: 8,
    };
  },
};
