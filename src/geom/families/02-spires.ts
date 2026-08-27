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
  proportions: { footprint: 16, height: 29, pieces: 89 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    // Kolik pater a kolik věží stojí v řadě je vlastnost rodiny, ne semínka.
    // Když to losoval seed, měnil výšku a šířku celé siluety a dvě semínka Věží
    // se rozešla víc než dvě rodiny — naměřeno 24. 8. 2026 profilem 0,066 proti
    // stropu 0,012. Semínku zůstává terén a rozmístění sloupů kolem, tedy
    // rozmístění kusů; silueta rodiny je pevná.
    const floors = 6;
    const towers = 6;
    const outliers = nextInt(stream, 15, 16);

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'ridge',
          extent: [22.4, 22.4],
          amplitude: 8,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'column', variant: 'pillar', at: [-9.6, 3.2, 0], scale: [6.4, 6.4, 6.4] },
        { kind: 'repeat', child: 1, count: floors, step: [0, 6.2, 0] },
        { kind: 'repeat', child: 2, count: towers, step: [3.8, 0, 0] },
        { kind: 'mirror', child: 3, axis: 'z', about: 3.2 },
        { kind: 'arch', variant: 'portal', at: [0, 24, 1.6], scale: [5.8, 5.8, 5.8] },
        { kind: 'column', variant: 'twisted', at: [0, 2.4, 0], scale: [4.8, 4.8, 4.8] },
        {
          kind: 'scatter',
          child: 6,
          count: outliers,
          radius: 7.2,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'group', children: [0, 4, 5, 7] },
      ],
      root: 8,
    };
  },
};
