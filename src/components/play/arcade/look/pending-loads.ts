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

/**
 * Těla rolí mají ve frontě modelů přednost (P62 T11). Scéna montuje podlahu, stěny a kulisy dřív než těla, takže
 * se jejich modely stahovaly a rozbalovaly první: hrad v aréně má 27 modelů a rytíř šel poslední – na listu T7
 * stál hrdina v 1 i 3 s jako modrý kvádr. Kulisa (`loadFlatModel`, `paintedPlant`) proto čeká na `afterBodies`.
 */
const bodies = new Set<Promise<unknown>>();

/** Zapíše načítání těla (hrdina, nepřítel, věc hry) a vrátí ho beze změny. */
export function trackBody<T>(load: Promise<T>): Promise<T> {
  bodies.add(load);
  const drop = (): void => {
    bodies.delete(load);
  };
  load.then(drop, drop);
  return trackLoad(load);
}

/**
 * Chvíle, kdy smí začít kulisa: po úloze, ve které o ni scéna požádala – efekty těl z téhož potvrzení Reactu
 * stojí ve stromu až za podlahou a kulisami –, a po tělech, která se v tu chvíli načítají.
 */
export function afterBodies(): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, 0))
    .then(() => Promise.allSettled([...bodies]))
    .then(() => undefined);
}
