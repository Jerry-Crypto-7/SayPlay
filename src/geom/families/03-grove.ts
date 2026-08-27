import { GEOM_VERSION, type GeomProgram } from '../program';

import { familyStream, nextInt, type Family } from './family';

/**
 * Háj — zvlněná zem zarostlá porostem, žádná stavba.
 *
 * Silueta je rozdrobená: scénu nese výhradně kategorie `organic`, takže
 * v profilu nejsou svislé ani vodorovné pásy, ale shluky. Paleta je zelená,
 * což ji od zbylých tří rodin odděluje i barvou.
 *
 * **Zem je `ridge`, ne `basin`, a je to jediný důvod, proč je porost vidět.**
 * Naměřeno 24. 8. 2026: `basin` bere odstín `moss` a `moss` je zároveň barva
 * listí (`organic.tree`, `organic.shrub`, `organic.reed` v kitu), takže se celá
 * scéna slila do jedné zelené plochy — postavený obsah zabíral **0,4 %**
 * snímku. `plateau` to neřeší, ten porost naopak schová úplně (naměřeno 0,0 %:
 * mesa vyroste nad něj). `ridge` bere `shell`, který v Háji nese jenom balvan,
 * takže se listí od země odděluje barvou i tvarem.
 */
export const grove: Family = {
  id: 'grove',
  title: 'Háj',
  palette: 'thicket',
  silhouette: 'porost ve shlucích, žádná rovná hrana, žádná stavba',
  proportions: { footprint: 12, height: 13, pieces: 104 },

  compose(seed: number): GeomProgram {
    const stream = familyStream(seed);
    // Rozpětí počtů je užší, než bývalo. Kusy jsou po přeskládání porostu
    // podstatně větší, takže čtyři kusy sem nebo tam hýbou siluetou rodiny, ne
    // jen rozmístěním — a to je přesně to, co strop na dvojice uvnitř rodiny
    // zakazuje.
    // **Počty porostu jsou pevné, losuje se jen počet balvanů.** Naměřeno
    // 27. 8. 2026 v `e2e/divergence.spec.ts`: s pěti kolísajícími počty vyšel
    // profil dvou semínek Háje na **0,0129 proti stropu 0,012**, tedy dvě
    // semínka téže rodiny se rozešla v siluetě víc, než rodina snese. Každý
    // kolísající počet posune sloupcové pokrytí celého snímku; balvan je z pěti
    // vrstev jediný nízký a široký, takže siluetu hne nejmíň — a nechat jednu
    // vrstvu kolísat je nutné, jinak dvě semínka vydají bajt po bajtu tutéž
    // kulisu.
    const trees = 24;
    const shrubs = 24;
    const boulders = nextInt(stream, 11, 13);
    const reeds = 24;
    const clusters = 20;

    return {
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'terrain',
          variant: 'ridge',
          extent: [21, 21],
          amplitude: 5.1,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'organic', variant: 'tree', scale: [4.4, 7.6, 4.4] },
        { kind: 'scatter', child: 1, count: trees, radius: 8.7, seed: nextInt(stream, 0, 100_000) },
        { kind: 'organic', variant: 'shrub', scale: [3.1, 3.1, 3.1] },
        { kind: 'scatter', child: 3, count: shrubs, radius: 9.7, seed: nextInt(stream, 0, 100_000) },
        { kind: 'organic', variant: 'boulder', scale: [4.1, 3.1, 4.1] },
        { kind: 'scatter', child: 5, count: boulders, radius: 7.1, seed: nextInt(stream, 0, 100_000) },
        { kind: 'organic', variant: 'reed', scale: [2.7, 5.4, 2.7] },
        { kind: 'scatter', child: 7, count: reeds, radius: 10.2, seed: nextInt(stream, 0, 100_000) },
        // Podrost mezi kmeny. Shluk je nízký a široký, takže siluetu Háje
        // zahustí u země — tam, kde byla mezi stromy vidět holá zem.
        { kind: 'organic', variant: 'cluster', scale: [3.4, 2.6, 3.4] },
        {
          kind: 'scatter',
          child: 9,
          count: clusters,
          radius: 9.2,
          seed: nextInt(stream, 0, 100_000),
        },
        { kind: 'group', children: [0, 2, 4, 6, 8, 10] },
      ],
      root: 11,
    };
  },
};
