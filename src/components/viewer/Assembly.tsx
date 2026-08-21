'use client';

/**
 * Assembly — svět se před divákem **staví**, neproblikne.
 *
 * Do 21. 8. 2026 scéna vznikla celá v jednom snímku: `buildScene` zapsal matice
 * všech instancí a plátno je od prvního snímku kreslilo. Divák tedy nikdy
 * neviděl, že se svět staví — viděl, že tam najednou je. Tenhle soubor to mění
 * a drží se přitom dvou pravidel:
 *
 * 1. **Odhalování řídí simulovaný tik, ne hodiny.** Kolik kusů je vidět, je
 *    funkce `clock.tick` — a nic jiného. Nástěnný čas se v celé scéně čte pořád
 *    jen jednou, v `pump()`, a jeho jediný výstup je celý počet tiků. Proto
 *    `step(n)` z prohlížeče stavbu odkrokuje deterministicky bez čekání na
 *    skutečné vteřiny a proto na rychlosti stroje nezáleží: pomalý stroj
 *    vykreslí míň snímků, ne míň stavby.
 * 2. **Zapnutá animace nesmí být podmínkou toho, že svět uvidíš.** Při
 *    `prefers-reduced-motion: reduce` je celý svět vidět od tiku nula. Není to
 *    zkrácená animace, je to žádná — plán vrací `total` pro každý tik.
 *
 * **Rozvrh je čistá funkce a testuje se bez prohlížeče** (`__tests__/assembly.test.ts`).
 * To, co se bez prohlížeče dokázat nedá — že to opravdu takhle proběhne v
 * rendereru — měří `e2e/assembly.spec.ts` přes `window.__viewer.assembly()`.
 */

/**
 * Kolik tiků trvá stavba. 16 tiků je při 20 Hz (`src/sim/clock.ts`) 800 ms.
 *
 * Číslo stojí mezi dvěma mezemi, obě z AC úlohy: mezi prvním a posledním
 * odhaleným kusem musí uplynout **aspoň 8 tiků**, a celá stavba musí být hotová
 * **do 2,5 s**, což je při 20 Hz 50 tiků. Uvnitř toho intervalu rozhoduje
 * produktový slib „do dvou sekund se před tebou staví svět": 800 ms nechává
 * zbytek té vteřiny emisi a překladu, dvě sekundy samotné stavby by ho snědly.
 */
export const ASSEMBLY_TICKS = 16;

export interface AssemblyPlan {
  /** Kolik kusů se celkem odhaluje. */
  readonly total: number;
  /** Kolik tiků stavba trvá. Nula znamená „všechno hned" (tlumený pohyb). */
  readonly ticks: number;
  /** Kolik kusů je vidět v daném tiku. Neklesající. */
  readonly revealedAt: (tick: number) => number;
  /** Tik, ve kterém se objeví první kus. */
  readonly firstRevealTick: number;
  /** Tik, ve kterém se objeví poslední kus. */
  readonly lastRevealTick: number;
  readonly reducedMotion: boolean;
}

/**
 * Rozvrh odhalování.
 *
 * Rozprostírá `total` kusů přes `ticks` tiků tak, že **první kus je vidět v tiku
 * 0 a poslední v tiku `ticks - 1`** — pro libovolný počet kusů. Naivní „kolik se
 * jich vejde za tik" tuhle vlastnost nemá: svět o pěti kusech by byl hotový za
 * pět tiků a rozpětí by spadlo pod osmitikovou mez z AC, aniž by se cokoli
 * pokazilo. Rozpětí je tedy vlastnost rozvrhu, ne šťastného počtu kusů.
 *
 * Svět o jednom kusu rozpětí mít nemůže — první a poslední kus je tentýž. Vrací
 * se pro něj „všechno hned", protože stavba jednoho kusu není stavba.
 */
export function createAssemblyPlan(
  total: number,
  options: { readonly ticks?: number; readonly reducedMotion?: boolean } = {},
): AssemblyPlan {
  const reducedMotion = options.reducedMotion === true;
  const ticks = options.ticks ?? ASSEMBLY_TICKS;

  if (ticks < 2) throw new Error(`stavba přes ${ticks} tiků nemá první a poslední kus`);

  if (reducedMotion || total <= 1) {
    return {
      total,
      ticks: 0,
      revealedAt: () => total,
      firstRevealTick: 0,
      lastRevealTick: 0,
      reducedMotion,
    };
  }

  const span = ticks - 1;

  return {
    total,
    ticks,
    revealedAt: (tick: number) => {
      if (tick < 0) return 0;
      if (tick >= span) return total;
      return Math.min(total, Math.floor((tick * (total - 1)) / span) + 1);
    },
    firstRevealTick: 0,
    lastRevealTick: span,
    reducedMotion,
  };
}

export interface RevealTarget {
  readonly cell: readonly [number, number];
}

/**
 * Pořadí odhalování: **od středu ven**.
 *
 * Vrací pro každý prvek jeho pořadí, ne přerovnané pole — volající si kusy
 * rozděluje do instancovaných dávek podle id a potřebuje vědět, kolikátý v
 * celkovém pořadí každý z nich je.
 *
 * Rozhoduje čtvercová vzdálenost od středu mřížky; shody rozsoudí buňka a pak
 * původní index, takže tentýž svět dá pokaždé totéž pořadí. Odmocnina by
 * pořadím nehnula a jen by přidala zaokrouhlování.
 */
export function revealRanks(
  items: readonly RevealTarget[],
  grid: { readonly width: number; readonly height: number },
): readonly number[] {
  const centerX = (grid.width - 1) / 2;
  const centerY = (grid.height - 1) / 2;

  const order = items.map((item, index) => {
    const dx = item.cell[0] - centerX;
    const dy = item.cell[1] - centerY;
    return { index, distance: dx * dx + dy * dy, cell: item.cell };
  });

  order.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.cell[0] - right.cell[0] ||
      left.cell[1] - right.cell[1] ||
      left.index - right.index,
  );

  const ranks = new Array<number>(items.length);
  order.forEach((entry, rank) => {
    ranks[entry.index] = rank;
  });
  return ranks;
}

export interface Ranked<T> {
  readonly item: T;
  readonly rank: number;
}

/**
 * Instance jedné dávky **v pořadí odhalování**.
 *
 * Je to jednořádkové přerovnání a přesto má vlastní funkci a vlastní test:
 * `revealRanks` dokazuje, že pořadí jde od středu ven, ale nic nedokazovalo, že
 * ho scéna při zápisu instancí použije. Naměřeno mutací 21. 8. 2026 — obrácené
 * pořadí zápisu prošlo všemi třemi tvrzeními e2e, protože počty zůstaly tytéž a
 * změnilo se jen to, KTERÉ kusy se objeví dřív. Tvrzení o pořadí bylo do té
 * chvíle jen v komentáři.
 */
export function orderForReveal<T>(
  items: readonly T[],
  ranks: readonly number[],
  keep: (item: T) => boolean,
): readonly Ranked<T>[] {
  return items
    .map((item, index) => ({ item, rank: ranks[index] }))
    .filter((entry) => keep(entry.item))
    .sort((left, right) => left.rank - right.rank);
}

/**
 * Kolik prvků z **vzestupně seřazených** pořadí je odhalených.
 *
 * Dávka `InstancedMesh` kreslí instance `[0, count)`, takže odhalená část musí
 * být předpona dávky — proto se instance zapisují v pořadí odhalování a tady
 * stačí spočítat, kolik jich je pod hranicí.
 */
export function revealedInBatch(ranks: readonly number[], revealed: number): number {
  let low = 0;
  let high = ranks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranks[middle] < revealed) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Co se z prohlížeče dá o stavbě zjistit.
 *
 * `firstRevealTick` a `lastRevealTick` jsou **pozorované**, ne opsané z plánu:
 * scéna si je zapisuje ve chvíli, kdy odhalených kusů poprvé přibylo a kdy
 * poprvé byly všechny. Rozvrh, který by tvrdil osm tiků a odhalil všechno
 * naráz, by tedy vrátil obě čísla stejná — a e2e ho shodí.
 */
export interface AssemblySnapshot {
  readonly revealed: number;
  readonly total: number;
  readonly firstRevealTick: number | null;
  readonly lastRevealTick: number | null;
  /**
   * Rozpětí, které rozvrh **předepisuje** — na rozdíl od dvojice výš, která
   * říká, co se pozorovalo.
   *
   * Obě čísla jsou potřeba a měří jinou věc. Pozorované rozpětí závisí na tom,
   * jak často stroj vykresluje: scéna zapisuje mezník jen při překreslení, takže
   * pomalý stroj mezi dvěma snímky přeskočí víc tiků a rozpětí vyjde delší, než
   * jaké rozvrh předepsal (naměřeno 21. 8. 2026 pod SwiftShaderem: 35 místo 15).
   * Na rozpočet stavby se proto ptej tohohle čísla, na to, že se stavba opravdu
   * rozprostřela, těch pozorovaných.
   */
  readonly plannedSpanTicks: number;
  readonly done: boolean;
  readonly reducedMotion: boolean;
}

/** Zápisník pozorování. Plní ho scéna při každém překreslení z tiku. */
export interface AssemblyLog {
  revealed: number;
  firstRevealTick: number | null;
  lastRevealTick: number | null;
}

export function createAssemblyLog(): AssemblyLog {
  return { revealed: 0, firstRevealTick: null, lastRevealTick: null };
}

/**
 * Zaznamená, kolik kusů scéna v tomhle tiku **doopravdy nakreslila**.
 *
 * `shown` je součet instancí, které dávky po zápisu opravdu kreslí — ne číslo,
 * které rozvrh vydal. Rozdíl je celý smysl toho zápisníku: rozvrh se dá napsat
 * správně a scéna ho může ignorovat, a pak by snímek hlásil postupnou stavbu
 * nad scénou, která se objevila naráz. Naměřeno mutací 21. 8. 2026 — dokud se
 * zapisovalo číslo z rozvrhu, vada, po které dávka kreslila vždy všechno, prošla
 * všemi třemi tvrzeními e2e.
 *
 * Zapisuje se jen **první** výskyt obou mezníků: tik, ve kterém nakreslených
 * poprvé nebyla nula, a tik, ve kterém jich poprvé bylo všechno. Pozdější tiky
 * s nimi nehnou, takže rozpětí je rozpětí stavby, ne délka běhu.
 */
export function recordReveal(log: AssemblyLog, plan: AssemblyPlan, tick: number, shown: number): void {
  log.revealed = shown;
  if (shown > 0 && log.firstRevealTick === null) log.firstRevealTick = tick;
  if (shown >= plan.total && log.lastRevealTick === null) log.lastRevealTick = tick;
}

export function assemblySnapshot(log: AssemblyLog, plan: AssemblyPlan): AssemblySnapshot {
  return {
    revealed: log.revealed,
    total: plan.total,
    firstRevealTick: log.firstRevealTick,
    lastRevealTick: log.lastRevealTick,
    plannedSpanTicks: plan.lastRevealTick - plan.firstRevealTick,
    done: log.revealed >= plan.total,
    reducedMotion: plan.reducedMotion,
  };
}

/**
 * Ptá se prohlížeče, jestli si divák vyžádal tlumený pohyb.
 *
 * Mimo prohlížeč (server, test bez DOM) vrací `false` — tam se nic nehýbe,
 * takže se není na co ptát.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
