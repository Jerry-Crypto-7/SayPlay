import { GEOM_VERSION, type GeomProgram } from '../program';

import { familyStream, nextInt, type Family } from './family';

/**
 * Terasy — široká, nízká krajina odstupňovaných desek.
 *
 * Silueta leží: nic nepřesáhne pár polí nad zem a scéna se roztahuje do stran.
 * Je to protipól **Věží**, se kterými se měří odlišnost profilu.
 *
 * **Deska je široká schválně, kusy na ní taky.** Do 24. 8. 2026 stála hrstka
 * malých stupňů na desce o hraně 40 a zem zabírala 98,8 % snímku. Šířka desky
 * je zároveň to, čím se Terasy liší od Háje v profilu siluety — užší deska ty
 * dvě rodiny sblíží pod podlahu `minCrossFamilyProfile`.
 */
export const terraces: Family = {
  id: 'terraces',
  title: 'Terasy',
  palette: 'dunes',
  silhouette: 'stupně a desky, vodorovné pásy, nic vysokého',
  proportions: { footprint: 17, height: 7, pieces: 102 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    // Počty jsou pevné nebo v úzkém rozpětí schválně — širší rozpětí hýbe
    // siluetou, ne rozmístěním, a dvě semínka jedné rodiny se pak rozejdou víc
    // než dvě rodiny (naměřeno u Věží 24. 8. 2026). Rozpětí zůstalo tam, kde
    // kus jenom leží na ploše a siluetu nenese.
    const steps = 8;
    const plinths = nextInt(stream, 21, 22);
    const decks = 6;
    const bevels = nextInt(stream, 19, 20);

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'plateau',
          extent: [33, 33],
          amplitude: 3.4,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'mass', variant: 'step', at: [-13, 0, -7.5], scale: [6.4, 3.2, 6.4] },
        { kind: 'repeat', child: 1, count: steps, step: [3.6, 0.7, 0] },
        { kind: 'mirror', child: 2, axis: 'z' },
        { kind: 'mass', variant: 'plinth', scale: [5.6, 2.4, 5.6] },
        {
          kind: 'scatter',
          child: 4,
          count: plinths,
          radius: 12,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'panel', variant: 'floor', at: [-9, 1, 10.5], scale: [7.6, 2.4, 7.6] },
        { kind: 'repeat', child: 6, count: decks, step: [6, 0, 0] },
        // Zábradlí na hraně desek. Vodorovný pás, tedy přesně to, čím se rodina
        // pozná — a kus s 48 trojúhelníky místo 24, takže nese hustotu, aniž by
        // do siluety přidal jedinou svislici.
        { kind: 'panel', variant: 'railing', at: [-13.6, 2.6, -13.4], scale: [3.4, 2.2, 3.4] },
        { kind: 'repeat', child: 8, count: 16, step: [1.8, 0, 0] },
        { kind: 'mirror', child: 9, axis: 'z' },
        { kind: 'mass', variant: 'bevel', scale: [3.2, 1.6, 3.2] },
        {
          kind: 'scatter',
          child: 11,
          count: bevels,
          radius: 15,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'group', children: [0, 3, 5, 7, 10, 12] },
      ],
      root: 13,
    };
  },
};
