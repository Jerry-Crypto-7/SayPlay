'use client';

/**
 * Skořápka produktu — **svět dostane celou obrazovku**.
 *
 * Do vlny 0 vypadala úvodní stránka takhle: pole na větu v horním pruhu, čtyři
 * až pět průsvitných karet ve dvou dolních rozích a plátno mezi nimi. Karty
 * ukazovaly vnitřnosti potrubí — program, časovou osu, náhled vítězné cesty,
 * kola oprav, stahování modelu. Design book §15.3 a §15.5 to obrací: plátno je
 * celý viewport a rozhraní jsou **tři věci** u spodní hrany.
 *
 * ## Co tahle komponenta dělá a co schválně nedělá
 *
 * Je to **rozvržení, ne stav** — vlastní `useState` tu není ani jeden. Všechno
 * včetně toho, jestli je Inspect otevřený, drží `src/app/page.tsx`; sem se
 * posílají hotové uzly. Otevření zásuvky patří stránce proto, že na něm visí
 * `ModelProgress`: ten se **nesmí odpojit** se zavřenou zásuvkou, jinak se
 * přestane načítat model.
 *
 * ## Rozhraní je jedna mřížka, ne čtyři kotvené rohy
 *
 * `.ws-shell` v `theme.css`: tři sloupce (ovládání · dok · Inspect) a dva řádky.
 * Je to **oprava vady, která se tady zopakovala počtvrté** — dva průsvitné boxy
 * se potkaly a jeden druhému sebral kliknutí. Naposledy 27. 8. 2026, kdy si
 * otevřená zásuvka lehla přes `Build the world`.
 *
 * Absolutní kotvení tu vadu umožňuje z definice: dva boxy se kotví nezávisle,
 * takže o průniku rozhodne až běhové rozvržení. V mřížce bydlí každý ve svém
 * sloupci a **protnout se nemají kde**. Nový prvek patří do buňky, vlastní
 * `position: absolute` s rohem do něj nedávej.
 *
 * ## Pořadí uzlů je součást správnosti, ne estetika
 *
 * `PromptDock` stojí v DOM **první**, protože prvním interaktivním prvkem
 * stránky musí zůstat vstup pro větu — hlídá to `e2e/render-quality.spec.ts`.
 * Ovládání i přepínač Inspectu jsou taky tlačítka, takže kdyby stály výš,
 * převzaly by to místo. Vidět je to na nich ale není: o umístění rozhoduje
 * `grid-column`, ne pořadí v DOM, takže dok se pořád kreslí uprostřed.
 *
 * Plátno stojí mimo mřížku a **poslední v DOM**. Že se přesto kreslí pod vším,
 * zařídí `z-index` překryvu: `<Canvas>` je nepozicovaný, takže pozicovaný
 * překryv maluje nad ním bez ohledu na pořadí.
 */

import type { ReactNode } from 'react';

import InspectDrawer from './InspectDrawer';
import PromptDock from './PromptDock';

export default function WorldstreamApp({
  stage,
  prompt,
  status,
  empty = null,
  controls = null,
  inspect,
  inspectBackground = null,
  inspecting,
  onInspect,
}: {
  /** Plátno. Kreslí se pod vším ostatním a zabírá celý viewport. */
  readonly stage: ReactNode;
  /** Vstup pro větu. */
  readonly prompt: ReactNode;
  /** Jedna stavová věta nad vstupem. */
  readonly status: ReactNode;
  /** Prázdný stav uprostřed plátna, dokud nepadla první věta. */
  readonly empty?: ReactNode;
  /** Herní ovládání vlevo dole. Stojí tam jen tehdy, když je co hrát. */
  readonly controls?: ReactNode;
  /** Panely Inspectu. Do stromu se dostanou teprve po otevření zásuvky. */
  readonly inspect: ReactNode;
  /** Uzly Inspectu, které musí být připojené i zavřené — viz `InspectDrawer`. */
  readonly inspectBackground?: ReactNode;
  /** Je zásuvka otevřená? Stav drží stránka. */
  readonly inspecting: boolean;
  /** Přepnutí zásuvky. */
  readonly onInspect: () => void;
}) {
  return (
    <main data-testid="worldstream" style={SHELL}>
      <div className="ws-shell" data-inspecting={inspecting}>
        <PromptDock status={status}>{prompt}</PromptDock>
        {controls === null ? null : <div className="ws-controls">{controls}</div>}
        <InspectDrawer open={inspecting} onToggle={onInspect} background={inspectBackground}>
          {inspect}
        </InspectDrawer>
      </div>
      {empty}
      {stage}
    </main>
  );
}

const SHELL: React.CSSProperties = {
  position: 'relative',
  height: '100dvh',
  width: '100vw',
  overflow: 'hidden',
};
