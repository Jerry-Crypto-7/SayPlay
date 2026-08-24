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
  proportions: { footprint: 19, height: 10, pieces: 36 },

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
          extent: [37, 37],
          amplitude: 0.9,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'panel', variant: 'wall', at: [-13.6, 1.7, -10.2], scale: [2.2, 4.4, 2.2] },
        { kind: 'repeat', child: 1, count: bays, step: [2, 0, 0] },
        { kind: 'carve', child: 2, at: [-8.5, 1.7, -10.2], size: [2.7, 5.1, 5.8] },
        { kind: 'repeat', child: 3, count: halls, step: [0, 0, 8.5] },
        { kind: 'mass', variant: 'block', at: [-10.2, 1.5, 13.6], scale: [4.4, 3.1, 4.4] },
        { kind: 'repeat', child: 5, count: blocks, step: [5.1, 0, 0] },
        { kind: 'arch', variant: 'flat', at: [0, 0, -15.3], scale: [4.1, 4.1, 4.1] },
        { kind: 'group', children: [0, 4, 6, 7] },
      ],
      root: 8,
    };
  },
};
