/**
 * Jediné hodiny simulace jsou fixní simulovaný krok (`VERIFY.md` §3.3).
 *
 * Autoritativní frekvence je 20 Hz, protože při ní je počítaný celý odhad
 * stavového prostoru v `DESIGN-BOOK.md` §4 a §6 — pětisekundový časovač má
 * ~102 stavů. Při 60 Hz by týž časovač měl ~302 stavů a rozpočet enumerace
 * verifikátoru by se ztrojnásobil. Není to volba pohodlí, je to podmínka
 * proveditelnosti verifikátoru.
 *
 * Frekvence má jediný zdroj pravdy — konstantu níž. Vykreslování běží na své
 * vlastní frekvenci a simulace se na snímky nikdy neváže.
 */
export const TICK_HZ = 20;

export const TICK_DT = 1 / TICK_HZ;

export const TICK_MS = 1000 / TICK_HZ;

export interface SimClock {
  /** Počet odkrokovaných tiků od začátku běhu. */
  tick: number;
  /** Nástěnný zbytek pod hranicí jednoho tiku. Dělený tik neexistuje. */
  accumulatorMs: number;
}

export function createClock(): SimClock {
  return { tick: 0, accumulatorMs: 0 };
}

/**
 * Převede uplynulý nástěnný čas na celý počet tiků, které se mají odkrokovat.
 * Zbytek pod tikem zůstává v akumulátoru, takže se nástěnný čas neztrácí po
 * kouscích a posloupnost tiků nezávisí na tom, jak hustě se hodiny pumpují.
 */
export function pump(clock: SimClock, elapsedMs: number): number {
  clock.accumulatorMs += elapsedMs;
  const due = Math.floor(clock.accumulatorMs / TICK_MS);
  clock.accumulatorMs -= due * TICK_MS;
  return due;
}

/**
 * Odkrokuje `count` tiků. Tohle je jediné místo, kde se `tick` zvyšuje —
 * replay cesta tedy nemá jak sáhnout na nástěnný čas, i kdyby chtěla.
 */
export function runTicks(clock: SimClock, count: number, onTick: (tick: number) => void): void {
  for (let i = 0; i < count; i += 1) {
    onTick(clock.tick);
    clock.tick += 1;
  }
}
