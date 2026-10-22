/**
 * Modely, které se právě načítají (`load.ts`, `RiggedModel.tsx`). Vyměněná scéna kola řetězu (`DrawWhenCompiled`,
 * T13a) počká, až doběhnou: jejich materiály se pak přeloží mimo hlavní vlákno s ostatními, ne v první kresbě po
 * příchodu modelu (na telefonu snímek 117–183 ms).
 */

const pending = new Set<Promise<unknown>>();

/** Zapíše načítání a vrátí ho beze změny. */
export function trackLoad<T>(load: Promise<T>): Promise<T> {
  pending.add(load);
  const drop = (): void => {
    pending.delete(load);
  };
  load.then(drop, drop);
  return load;
}

/** Kolik načítání ještě běží. */
export const loadsPending = (): number => pending.size;

/** Doběhne, až doběhne všechno, co se načítá teď. */
export function loadsSettled(): Promise<void> {
  return Promise.allSettled([...pending]).then(() => undefined);
}
