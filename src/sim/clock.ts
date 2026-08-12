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

/**
 * Strop dohánění v jednom pumpnutí.
 *
 * Uspaná záložka se probudí se skokem nástěnných hodin o desítky sekund; bez
 * stropu by z třicetisekundového skoku vzniklo 600 tiků v jednom snímku, což je
 * spirála smrti — dohánění trvá déle než uplynulý čas a akumulátor roste dál.
 *
 * 25 tiků je 1,25 s. Číslo je zvolené proti reálnému throttlingu: záložka na
 * pozadí dostává timery zhruba jednou za sekundu, tedy 20 tiků na pumpnutí, a
 * ta se s tímhle stropem doháněla celá. Škrtá se až skutečný skok, ne běžné
 * zpomalení.
 */
export const MAX_CATCHUP_TICKS = 25;

export interface SimClock {
  /** Počet odkrokovaných tiků od začátku běhu. */
  tick: number;
  /** Nástěnný zbytek pod hranicí jednoho tiku. Dělený tik neexistuje. */
  accumulatorMs: number;
  /** Tiky zahozené stropem dohánění. Nástěnná nespojitost je vidět, ne tichá. */
  droppedTicks: number;
}

export function createClock(): SimClock {
  return { tick: 0, accumulatorMs: 0, droppedTicks: 0 };
}

/**
 * Převede uplynulý nástěnný čas na celý počet tiků, které se mají odkrokovat.
 * Zbytek pod tikem zůstává v akumulátoru, takže se nástěnný čas neztrácí po
 * kouscích a posloupnost tiků nezávisí na tom, jak hustě se hodiny pumpují.
 *
 * Přebytek nad stropem se **zahodí, ne odloží**: kdyby se přenesl do akumulátoru,
 * příští pumpnutí by ho dostalo znovu a strop by jen rozložil tutéž spirálu do
 * více snímků. Simulovaný čas je po probuzení pozadu za nástěnným — a to je
 * správně, protože simulovaný tik je jediná jednotka a replay cesta nástěnné
 * hodiny nečte vůbec.
 *
 * Záporný `elapsedMs` (posun systémových hodin zpět) nepřidá nic. Vracet záporný
 * počet tiků nejde a couvání simulace není definované.
 */
export function pump(clock: SimClock, elapsedMs: number): number {
  if (elapsedMs > 0) {
    clock.accumulatorMs += elapsedMs;
  }

  const due = Math.floor(clock.accumulatorMs / TICK_MS);
  clock.accumulatorMs -= due * TICK_MS;

  if (due <= MAX_CATCHUP_TICKS) {
    return due;
  }

  clock.droppedTicks += due - MAX_CATCHUP_TICKS;
  return MAX_CATCHUP_TICKS;
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
