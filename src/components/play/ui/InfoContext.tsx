'use client';

/**
 * Jeden list „About this game“ místo tří proužků nad hrou (P33 T7).
 *
 * `SentenceRead`, `HowItWorks` a `Lineage` připojuje shell každou zvlášť
 * (`ArcadePlay.tsx` patří stopě D), takže se domluví přes tenhle kontext:
 * pod `InfoSheetProvider` zapíšou `HowItWorks` a `Lineage` svůj obsah sem a
 * samy nic nekreslí, `SentenceRead` vykreslí řádek-tlačítko a list, ve kterém
 * jsou všechny tři oddíly. Bez poskytovatele (feed) kreslí každá sama sebe.
 *
 * Obsah se zapisuje v efektu, takže ho server nevykreslí – list je při
 * načtení zavřený, a tak to nevadí.
 */

import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';

export type InfoPart = 'how' | 'lineage';
type Parts = Readonly<Partial<Record<InfoPart, ReactNode>>>;

interface InfoStore {
  readonly parts: () => Parts;
  readonly set: (part: InfoPart, node: ReactNode) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createInfoStore(): InfoStore {
  let parts: Parts = {};
  const listeners = new Set<() => void>();
  return {
    parts: () => parts,
    set(part, node) {
      parts = { ...parts, [part]: node };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const InfoContext = createContext<InfoStore | null>(null);

export function InfoSheetProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createInfoStore);
  return <InfoContext.Provider value={store}>{children}</InfoContext.Provider>;
}

/**
 * Zapíše oddíl do listu. Vrací `true`, když list existuje a volající má
 * vrátit `null`. `node` musí být stabilní (`useMemo`) – každá nová hodnota
 * znamená zápis a nové vykreslení listu.
 */
export function useInfoPart(part: InfoPart, node: ReactNode): boolean {
  const store = useContext(InfoContext);
  useEffect(() => {
    if (store === null) return;
    store.set(part, node);
    return () => store.set(part, undefined);
  }, [store, part, node]);
  return store !== null;
}

/** Je nad volajícím list „About this game“? Ve feedu ne – tam se nic navíc nenačítá. */
export function useInInfoSheet(): boolean {
  return useContext(InfoContext) !== null;
}

const NO_PARTS: Parts = {};
const quiet = () => () => {};

/** Oddíly, které do listu zapsali sourozenci; bez poskytovatele žádné. */
export function useInfoParts(): Parts {
  const store = useContext(InfoContext);
  return useSyncExternalStore(store?.subscribe ?? quiet, store?.parts ?? (() => NO_PARTS), () => NO_PARTS);
}
