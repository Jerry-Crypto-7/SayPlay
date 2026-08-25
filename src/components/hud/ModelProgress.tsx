'use client';

/**
 * Stahování modelu jako oznámení v rohu, ne jako brána přes celou obrazovku (P11 T22).
 *
 * ## Od T9 je to skutečný stav skutečného modelu
 *
 * P11 T22q komponentu správně odpojila, dokud hotový engine nikdo nepoužíval.
 * P12 V1 T9 ji vrací až spolu s volajícím: `onReady` předá engine cestě emise a
 * `onState` drží UI ve shodě s tím, zda se model zkoumá, načítá nebo není
 * dostupný. Naměřený medián je 33,9 s, takže panel nesmí blokovat náhradní svět.
 *
 * ## Co se tu rozhoduje
 *
 * Váhy mají skoro gigabajt. Kdyby na ně produkt čekal, porotce by první dvě
 * minuty koukal na ukazatel a **teze projektu by se za tu dobu nestihla ukázat**
 * — přitom hlavní cestou je deterministický rozpoznávač tvarů, který model
 * nepotřebuje vůbec (`src/model/local/shapes.ts`, rozhodnutí v
 * `evals/local-model/decision.md`). Model je doplněk pro věty mimo rozpoznané
 * tvary, a doplněk nesmí blokovat.
 *
 * Proto tahle komponenta **nic nevrací nahoru synchronně a nic nezdržuje**:
 * pověsí se na `useEffect`, běží vedle a hlásí, jak jí to jde.
 *
 * ## Proč se stav vystavuje atributem, ne jen barvou
 *
 * `data-phase` čte e2e (`e2e/first-click.spec.ts`) a ptá se ho na jedinou
 * otázku, na kterou se ptát má: **dá se kliknout, zatímco se model stahuje?**
 * Bez strojově čitelné fáze by se ta otázka dala zodpovědět jen odhadem z toho,
 * co je zrovna na obrazovce.
 *
 * ## Proč se panel po načtení schová
 *
 * Hotový model není novinka, je to výchozí stav. Trvalý ukazatel „model
 * připraven" by zabíral roh obrazovky navždy a nic nesděloval. Uzel v DOM
 * zůstává (kvůli `data-phase`), viditelný obsah ne.
 */

import { useEffect, useRef, useState } from 'react';

import { detectRuntime, probeEnvironment, type Runtime } from '@/model/local/capability';
import { loadEngine, modelForRuntime, type ChatEngine } from '@/model/local/engine';

/** Kde je model teď. Pořadí je pořadí, ve kterém se fáze střídají. */
export type ModelPhase =
  /** Zjišťuje se, jestli tenhle stroj model vůbec utáhne. */
  | 'probing'
  /** Váhy se stahují nebo nahrávají do GPU. */
  | 'loading'
  /** Model odpovídá. */
  | 'ready'
  /** Na tomhle stroji model neběží, nebo se ho nepodařilo nahrát. */
  | 'unavailable';

export interface ModelState {
  readonly phase: ModelPhase;
  /** Větev z `detectRuntime()`; `null`, dokud se neprobralo prostředí. */
  readonly runtime: Runtime | null;
  /** Poslední hlášení WebLLM, nebo důvod, proč to nevyšlo. Prázdné na začátku. */
  readonly detail: string;
}

const INITIAL: ModelState = { phase: 'probing', runtime: null, detail: '' };

/**
 * Text pro diváka.
 *
 * Hlášení WebLLM je technické (`Fetching param cache[12/38]: 402MB fetched`) a
 * mění se každou chvíli, takže se **nevypisuje samo**: stojí za vlastní větou,
 * která říká, co se děje a proč to nikomu nevadí.
 */
export function captionFor(state: ModelState): string | null {
  if (state.phase === 'probing') return 'Checking whether this machine can run the model…';
  if (state.phase === 'loading') return 'The model is downloading in the background. You can play right now.';
  return null;
}

export default function ModelProgress({
  /** Dostane hotový model. Nepovinné — komponenta funguje i tehdy, když ho nikdo nechce. */
  onReady,
  onState,
}: {
  /** Dostane hotový model; stránka ho předá promptové cestě. */
  readonly onReady?: (engine: ChatEngine) => void;
  /** Dostane každý pravdivý stav, včetně `unavailable`. */
  readonly onState?: (state: ModelState) => void;
} = {}) {
  const [state, setState] = useState<ModelState>(INITIAL);
  // Odpojená komponenta nesmí sahat na stav: stahování běží déle než leckterá
  // návštěva stránky a React by na to nadával do konzole.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const set = (next: ModelState): void => {
      if (!alive.current) return;
      setState(next);
      onState?.(next);
    };

    onState?.(INITIAL);

    void (async () => {
      const runtime = detectRuntime(await probeEnvironment());
      if (modelForRuntime(runtime) === null) {
        set({ phase: 'unavailable', runtime, detail: 'this browser does not run the model' });
        return;
      }

      set({ phase: 'loading', runtime, detail: '' });
      try {
        const engine = await loadEngine(runtime, (text) => set({ phase: 'loading', runtime, detail: text }));
        set({ phase: 'ready', runtime, detail: engine.modelId });
        onReady?.(engine);
      } catch (thrown) {
        // Nenačtený model **není pád produktu**: rozpoznávač tvarů je hlavní
        // cesta a ta jede dál. Vypíše se to a jde se dál.
        set({
          phase: 'unavailable',
          runtime,
          detail: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
        });
      }
    })();

    return () => {
      alive.current = false;
    };
  }, [onReady, onState]);

  const caption = captionFor(state);

  return (
    <div
      data-testid="model-progress"
      data-phase={state.phase}
      data-runtime={state.runtime ?? ''}
      // `pointerEvents: none` je celý ten slib v jedné vlastnosti: panel nesmí
      // stát mezi kurzorem a produktem, ani kdyby se překryl s čímkoli jiným.
      // `display: none`, ne `visibility: hidden`: ve sloupci pravého rohu by skrytý
      // panel pořád zabíral svou výšku a odstrčil náhled vítězné cesty o kus nahoru.
      // Uzel v DOM zůstává tak jako tak, takže `data-phase` jde číst dál.
      style={{ ...PANEL, pointerEvents: 'none', display: caption === null ? 'none' : 'block' }}
    >
      {caption === null ? null : (
        <>
          <p style={{ margin: 0 }}>{caption}</p>
          {state.detail === '' ? null : (
            <p data-testid="model-progress-detail" style={DETAIL}>
              {state.detail}
            </p>
          )}
        </>
      )}
    </div>
  );
}

const PANEL: React.CSSProperties = {
  // Ukotvení nese pravý sloupec v `src/app/page.tsx`. `pointerEvents: 'none'` se
  // dosazuje až v JSX, protože je to slib, ne kosmetika, a měří ho e2e.
  maxWidth: '20rem',
  padding: '0.5rem 0.7rem',
  borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.82)',
  color: '#9fc0c2',
  font: '12px/1.5 ui-monospace, monospace',
};

const DETAIL: React.CSSProperties = {
  margin: '0.25rem 0 0',
  color: '#2f9e8f',
  overflowWrap: 'anywhere',
};
