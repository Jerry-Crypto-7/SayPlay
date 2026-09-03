'use client';

/**
 * Dok — jediné místo, kde se s produktem mluví.
 *
 * Do vlny 0 stálo pole na větu nahoře uprostřed a pod ním se v rozích skládaly
 * čtyři panely. Design book §15.3 to ruší: plátno má celý viewport, rozhraní
 * jsou tři věci u spodní hrany — **jedna stavová věta, jedno pole a jeden
 * diskrétní bod pro Inspect**.
 *
 * ## Proč dok drží kotvení, a ne `PromptBar` sám
 *
 * Táž konvence, kvůli které vznikly sloupce v `src/app/page.tsx`: dokud si
 * panely kotvily rohy samy, dva páry si sedly na tentýž bod a braly si
 * kliknutí. `PromptBar` proto od téhle úlohy nemá vlastní `position: absolute`
 * — je to obyčejný prvek v toku a o jeho místo se stará `.ws-dock`.
 *
 * ## Pořadí v DOM je součást správnosti
 *
 * Věta stojí **nad** polem opticky, ale v DOM je první pole: prvním interaktivním
 * prvkem stránky musí zůstat vstup pro větu a hlídá to
 * `e2e/render-quality.spec.ts`. Optické pořadí zařídí `flex-direction:
 * column-reverse` na doku, ne přeházené JSX.
 */

import type { ReactNode } from 'react';

export default function PromptDock({
  axis = null,
  status,
  change = null,
  children,
}: {
  /**
   * Osa materializace a času (`T24`). V DOM hned za polem, tedy opticky **těsně
   * nad ním** — design book §15.3 ji kreslí mezi stavovou větu a vstup, protože
   * je to ovladač, a ovladače patří k ruce, ne k sdělení.
   */
  readonly axis?: ReactNode;
  /** Stavová věta. Vykreslí se nad polem, ale v DOM stojí za ním. */
  readonly status: ReactNode;
  /**
   * Rozsah druhé věty (`T23`). Poslední v DOM, tedy **nejvýš** na obrazovce:
   * `column-reverse` obrací pořadí a rozhodnutí patří nad sdělení.
   */
  readonly change?: ReactNode;
  /** Vstup pro větu. */
  readonly children: ReactNode;
}) {
  return (
    <div className="ws-dock" data-testid="prompt-dock">
      {children}
      {axis}
      {status}
      {change}
    </div>
  );
}
