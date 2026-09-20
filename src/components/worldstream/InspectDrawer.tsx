'use client';

/**
 * Inspect — jedno místo, kam se stěhuje všechno, co dřív stálo v rozích.
 *
 * Design book §15.5 jmenuje pět panelů, které z výchozí obrazovky mizí:
 * `Program`, `Timeline`, `WitnessPreview`, `RepairRounds`, `ModelProgress`.
 * **Nemažou se** — jsou to důkazy, na kterých produkt stojí, a porotce se na ně
 * musí umět podívat. Jen už neplatí, že je vidí každý, kdo přišel napsat větu.
 *
 * Od P22 T8 sem patří i `WhyPanel` (`src/components/worldstream/WhyPanel.tsx`).
 * Je to první panel, který zásuvku **otevírá sám**: klik na značku „Why?" pod
 * posuvníkem času nastaví ve stránce tik a `inspecting` naráz, protože panel,
 * který se objeví v zavřené zásuvce, není vidět — a porotce by hledal, kam se
 * jeho kliknutí podělo. Přepínač se přitom nemění: zavře i tenhle panel.
 *
 * ## Zavřená zásuvka opravdu nic nevykresluje
 *
 * `children` se do stromu dostanou teprve po otevření, ne skryté přes
 * `display: none`. Skrytý uzel je pořád ve výchozím DOM a měřit „obrazovka je
 * čistá" by pak nešlo — aserce by procházela nad pěti kartami, které jsou jen
 * neviditelné. Cenou je, že se panely po otevření staví od začátku; všechny
 * čtou stav shora ze stránky, takže je to bez následku.
 *
 * ## Proč `background` existuje a proč to není jen šestý panel
 *
 * `ModelProgress` **není jen panel** — jeho efekt spouští probe WebGPU, stahuje
 * váhy a hotový engine podává promptové cestě. Kdyby se odpojil se zavřenou
 * zásuvkou, model by se nikdy nezačal načítat a offline větev produktu by
 * tichounce zmizela. Uzel v `background` je proto připojený **pořád**; jestli
 * něco vykreslí, si rozhoduje sám podle `open`.
 */

import type { ReactNode } from 'react';

export default function InspectDrawer({
  open,
  onToggle,
  background = null,
  children,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  /**
   * Uzly, které musí být připojené i se zavřenou zásuvkou, protože něco dělají —
   * ne proto, že něco ukazují.
   */
  readonly background?: ReactNode;
  /** Panely. Do stromu se dostanou teprve po otevření. */
  readonly children: ReactNode;
}) {
  return (
    <aside className="ws-inspect" data-testid="inspect" data-open={open}>
      {open ? (
        <div className="ws-inspect-panels" data-testid="inspect-panels">
          {children}
        </div>
      ) : null}
      {/* Obal je tu i prázdný. Nese `margin-bottom: auto`, tedy jedinou věc,
          která drží panely u horní hrany a přepínač dole — a to musí platit
          i zavřené, kdy `background` nevykreslí nic. */}
      <div className="ws-inspect-background">{background}</div>
      <button
        type="button"
        className="ws-inspect-toggle"
        data-testid="inspect-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        Inspect
      </button>
    </aside>
  );
}
