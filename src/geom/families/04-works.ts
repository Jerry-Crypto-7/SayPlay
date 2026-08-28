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
  proportions: { footprint: 19, height: 10, pieces: 55 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    // Kolik lodí a kolik polí v nich je vlastnost rodiny, ne semínka — je to
    // ta pravoúhlá řada, podle které se Hutě poznají. Semínku zůstává zem a
    // délka řady bloků před halou, tedy rozmístění.
    const bays = 12;
    const halls = 4;
    const blocks = nextInt(stream, 6, 7);

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
        // `window` má tytéž rozměry jako `wall` (1,00 × 1,60 × 0,16), ale pět
        // krát víc trojúhelníků. Řada hal tak zhoustne, aniž by se silueta
        // rodiny pohnula o milimetr — a prosvětlená hala je pro huť na místě.
        { kind: 'panel', variant: 'window', at: [-13.6, 1.7, -10.2], scale: [2.2, 4.4, 2.2] },
        { kind: 'repeat', child: 1, count: bays, step: [2, 0, 0] },
        { kind: 'carve', child: 2, at: [-8.5, 1.7, -10.2], size: [2.7, 5.1, 5.8] },
        { kind: 'repeat', child: 3, count: halls, step: [0, 0, 8.5] },
        { kind: 'mass', variant: 'block', at: [-14.4, 1.5, 13.6], scale: [4.4, 3.1, 4.4] },
        { kind: 'repeat', child: 5, count: blocks, step: [5.1, 0, 0] },
        { kind: 'arch', variant: 'flat', at: [0, 0, -15.3], scale: [4.1, 4.1, 4.1] },
        // Hutě dostávají dron, ne člověka: rodina je průmyslová a dron smí
        // viset nad zemí, což u rovného terénu s amplitudou 0,9 znamená, že se
        // nemusí trefovat do výšky půdy. Drobnosti jsou tři, všechny provozní —
        // roura, terminál a poklop stojí u řady bloků před halou.
        { kind: 'actor', variant: 'drone', at: [-9, 2.6, 12], scale: [2, 2, 2] },
        { kind: 'fixture', variant: 'pipe', at: [-12, 1.4, 10.2], scale: [2.2, 2.2, 2.2] },
        { kind: 'fixture', variant: 'terminal', at: [-6.5, 1.3, 12.6], scale: [1.8, 1.8, 1.8] },
        { kind: 'fixture', variant: 'hatch', at: [-3, 0.6, 13.2], scale: [2, 2, 2] },
        { kind: 'group', children: [0, 4, 6, 7, 8, 9, 10, 11] },
      ],
      root: 12,
    };
  },
};
