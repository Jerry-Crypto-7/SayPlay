import { describe, expect, it } from 'vitest';

import {
  ASSEMBLY_TICKS,
  assemblySnapshot,
  createAssemblyLog,
  createAssemblyPlan,
  orderForReveal,
  recordReveal,
  revealRanks,
  revealedInBatch,
} from '../Assembly';

/** Mez z AC úlohy T11. Není to volba testu, je to číslo ze zadání. */
const MIN_SPAN_TICKS = 8;

describe('rozvrh stavby drží obě meze ze zadání', () => {
  it('mezi prvním a posledním kusem uplyne aspoň osm tiků', () => {
    const plan = createAssemblyPlan(240);

    expect(plan.lastRevealTick - plan.firstRevealTick).toBeGreaterThanOrEqual(MIN_SPAN_TICKS);
  });

  it.each([2, 3, 5, 17, 64, 240, 1000])(
    'rozpětí drží i pro %d kusů — je to vlastnost rozvrhu, ne šťastného počtu',
    (total) => {
      // Naivní „kolik se jich vejde za tik" tuhle vlastnost nemá: pět kusů by
      // bylo hotových za pět tiků a mez z AC by spadla, aniž by se co pokazilo.
      const plan = createAssemblyPlan(total);

      expect(plan.lastRevealTick - plan.firstRevealTick).toBeGreaterThanOrEqual(MIN_SPAN_TICKS);
    },
  );

  it.each([2, 3, 5, 17, 64, 240, 1000])('všech %d kusů je vidět v posledním tiku', (total) => {
    const plan = createAssemblyPlan(total);

    expect(plan.revealedAt(plan.lastRevealTick)).toBe(total);
    expect(plan.revealedAt(plan.lastRevealTick + 50)).toBe(total);
  });

  it('první kus je vidět hned v tiku nula, scéna nezačíná prázdnem', () => {
    expect(createAssemblyPlan(240).revealedAt(0)).toBeGreaterThan(0);
  });

  it('odhalených nikdy neubývá', () => {
    const plan = createAssemblyPlan(97);
    let previous = 0;

    for (let tick = 0; tick <= ASSEMBLY_TICKS + 5; tick += 1) {
      const revealed = plan.revealedAt(tick);
      expect(revealed).toBeGreaterThanOrEqual(previous);
      expect(revealed).toBeLessThanOrEqual(97);
      previous = revealed;
    }
  });

  it('záporný tik neodhalí nic — couvání stavby není definované', () => {
    expect(createAssemblyPlan(240).revealedAt(-1)).toBe(0);
  });

  it('stavba kratší než dva tiky nemá první a poslední kus, a je to vada', () => {
    expect(() => createAssemblyPlan(240, { ticks: 1 })).toThrow(/první a poslední/);
  });
});

describe('tlumený pohyb není zkrácená animace, je to žádná', () => {
  it('celý svět je vidět od tiku nula', () => {
    const plan = createAssemblyPlan(240, { reducedMotion: true });

    expect(plan.revealedAt(0)).toBe(240);
    expect(plan.ticks).toBe(0);
    expect(plan.reducedMotion).toBe(true);
  });

  it('a svět o jednom kusu se chová stejně, protože stavba jednoho kusu není stavba', () => {
    const plan = createAssemblyPlan(1);

    expect(plan.revealedAt(0)).toBe(1);
    expect(plan.firstRevealTick).toBe(plan.lastRevealTick);
  });
});

describe('pořadí odhalování jde od středu ven', () => {
  const grid = { width: 9, height: 9 };

  it('kus ve středu je první a kus v rohu poslední', () => {
    const items = [
      { cell: [0, 0] as const },
      { cell: [4, 4] as const },
      { cell: [4, 5] as const },
    ];

    const ranks = revealRanks(items, grid);

    expect(ranks[1]).toBe(0);
    expect(ranks[0]).toBe(2);
  });

  it('je to permutace — každé pořadí právě jednou', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      cell: [index % 9, Math.floor(index / 9)] as const,
    }));

    const ranks = revealRanks(items, grid);

    expect([...ranks].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 40 }, (_, index) => index),
    );
  });

  it('tentýž vstup dá totéž pořadí, i když dva kusy stojí na jedné buňce', () => {
    // Shodná vzdálenost i shodná buňka rozhoduje původním indexem, jinak by
    // pořadí záviselo na tom, jak řadí implementace `sort` v prohlížeči.
    const items = [{ cell: [2, 2] as const }, { cell: [2, 2] as const }, { cell: [6, 6] as const }];

    expect(revealRanks(items, grid)).toEqual(revealRanks(items, grid));
    expect(revealRanks(items, grid)[0]).toBeLessThan(revealRanks(items, grid)[1]);
  });
});

describe('instance dávky se zapisují v pořadí odhalování', () => {
  const statics = [
    { piece: 'a', cell: [0, 0] as const },
    { piece: 'b', cell: [4, 4] as const },
    { piece: 'a', cell: [4, 5] as const },
    { piece: 'a', cell: [1, 1] as const },
  ];
  const ranks = revealRanks(statics, { width: 9, height: 9 });

  it('vrátí jen kusy své dávky, vzestupně podle pořadí', () => {
    const ordered = orderForReveal(statics, ranks, (placement) => placement.piece === 'a');

    expect(ordered.map((entry) => entry.item.piece)).toEqual(['a', 'a', 'a']);
    expect(ordered.map((entry) => entry.rank)).toEqual([...ordered.map((entry) => entry.rank)].sort((l, r) => l - r));
  });

  it('nejbližší kus dávky je první, nejvzdálenější poslední', () => {
    // Tohle je aserce, která chyběla: `revealRanks` pořadí spočítá, ale dokud se
    // nekontroluje zápis, může ho scéna otočit a stavba pořád „proběhne".
    const ordered = orderForReveal(statics, ranks, (placement) => placement.piece === 'a');

    expect(ordered[0].item.cell).toEqual([4, 5]);
    expect(ordered[ordered.length - 1].item.cell).toEqual([0, 0]);
  });

  it('dávka bez kusů je prázdná, ne celý plán', () => {
    expect(orderForReveal(statics, ranks, (placement) => placement.piece === 'nic')).toEqual([]);
  });
});

describe('dávka kreslí odhalenou předponu', () => {
  it('spočítá, kolik pořadí dávky je pod hranicí', () => {
    const ranks = [0, 3, 4, 9];

    expect(revealedInBatch(ranks, 0)).toBe(0);
    expect(revealedInBatch(ranks, 1)).toBe(1);
    expect(revealedInBatch(ranks, 4)).toBe(2);
    expect(revealedInBatch(ranks, 10)).toBe(4);
    expect(revealedInBatch(ranks, 1000)).toBe(4);
  });

  it('prázdná dávka nekreslí nic při žádné hranici', () => {
    expect(revealedInBatch([], 50)).toBe(0);
  });
});

describe('pozorování stavby zapisuje nakreslené, ne chtěné', () => {
  /** Scéna, která rozvrh poslechne — kreslí přesně tolik, kolik jí vydal. */
  const obedient = (plan: ReturnType<typeof createAssemblyPlan>, log: ReturnType<typeof createAssemblyLog>, until: number) => {
    for (let tick = 0; tick <= until; tick += 1) recordReveal(log, plan, tick, plan.revealedAt(tick));
  };

  it('drží tik prvního a posledního kusu, pozdější tiky s nimi nehnou', () => {
    const plan = createAssemblyPlan(240);
    const log = createAssemblyLog();

    obedient(plan, log, ASSEMBLY_TICKS + 20);

    const snapshot = assemblySnapshot(log, plan);
    expect(snapshot.firstRevealTick).toBe(0);
    expect(snapshot.lastRevealTick).toBe(plan.lastRevealTick);
    expect(snapshot.done).toBe(true);
    expect(snapshot.revealed).toBe(240);
  });

  it('nedokončená stavba se za dokončenou nevydává', () => {
    const plan = createAssemblyPlan(240);
    const log = createAssemblyLog();

    recordReveal(log, plan, 0, plan.revealedAt(0));
    const snapshot = assemblySnapshot(log, plan);

    expect(snapshot.done).toBe(false);
    expect(snapshot.lastRevealTick).toBeNull();
    expect(snapshot.revealed).toBeLessThan(240);
  });

  it('rozvrh, který odhalí všechno naráz, vrátí obě čísla stejná — to e2e shodí', () => {
    // Přesně tahle náhražka je důvod, proč jsou mezníky pozorované a ne opsané
    // z rozvrhu: kdyby se četly z plánu, tvrdil by osm tiků i tenhle.
    const plan = createAssemblyPlan(240, { reducedMotion: true });
    const log = createAssemblyLog();

    obedient(plan, log, ASSEMBLY_TICKS);

    const snapshot = assemblySnapshot(log, plan);
    expect(snapshot.lastRevealTick! - snapshot.firstRevealTick!).toBe(0);
  });

  it('scéna, která rozvrh ignoruje a kreslí rovnou všechno, se pozná', () => {
    // Tohle je ta vada, kvůli které zápisník bere nakreslené číslo a ne chtěné:
    // rozvrh je v pořádku, ale dávka kreslí od začátku celý svět. Dokud se
    // zapisovalo číslo z rozvrhu, prošla všemi třemi tvrzeními e2e.
    const plan = createAssemblyPlan(240);
    const log = createAssemblyLog();

    for (let tick = 0; tick <= ASSEMBLY_TICKS; tick += 1) recordReveal(log, plan, tick, 240);

    const snapshot = assemblySnapshot(log, plan);
    expect(snapshot.lastRevealTick! - snapshot.firstRevealTick!).toBe(0);
    expect(snapshot.done).toBe(true);
  });
});
