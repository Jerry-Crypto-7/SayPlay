/**
 * Fáze jednoho tiku a jejich meze.
 *
 * `DESIGN-BOOK.md` §5 předepisuje čtyři kroky: vyhodnotit spouštěče a stráže
 * proti **pre-stavu tiku** → aplikovat akce ve stabilním pořadí → odvozené
 * události doručit **až v příštím tiku** → přetečení fronty je odmítnutí.
 *
 * Fáze jsou tu jako **data**, ne jako čtyři volání za sebou, protože T9 na nich
 * staví dvě ze čtyř strukturálních podmínek totality: vyčerpanost přechodů
 * (přepínač končí `never` větví) a ohraničenost každé fáze zvenčí (mez je
 * funkce deklarovaných mezí světa, nikdy vstupu).
 *
 * **Mez je shora, ne odhad.** `phaseBound` nesmí číst nic než `IrLimits` — kdyby
 * do ní vstoupil počet doručených událostí nebo cokoli jiného ze vstupu, přestala
 * by to být mez a stala by se z ní další proměnná, kterou může vstup zvětšit.
 */

import type { IrLimits } from '../ir/types';

export const PHASES = ['sense', 'trigger', 'apply', 'settle'] as const;

export type Phase = (typeof PHASES)[number];

/**
 * Horní mez počtu **položek**, které fáze zpracuje — součet přes všechny její
 * smyčky. Není to mez práce: tu drží rozpočet uvnitř primitiv (podmínka 5). Jsou
 * to dvě různá tvrzení a plán je odděluje schválně: „ohraničený počet kroků" a
 * „ohraničená práce" se snadno spletou a první z nich sama o sobě totalitu nedává.
 *
 * **Jednotlivé smyčky mají vlastní, těsnější meze** (`limits.maxSlots`,
 * `limits.maxEntities`, `pairBound`, …). Tahle funkce je jejich součet, protože
 * podmínka 4 mluví o fázi, ne o smyčce, a instrumentovaný čítač počítá iterace
 * všech smyček fáze dohromady. Kdyby vracela mez jedné smyčky, byla by aserce
 * `iterace ≤ mez` nepravdivá pro každou fázi, která má smyčky dvě.
 */
export function phaseBound(phase: Phase, limits: IrLimits): number {
  switch (phase) {
    case 'sense':
      // Sloty se procházejí dvakrát (stav a inventář), entity jednou a k nim
      // zóny, odvozené fakty jsou párové (`overlapping`, `visible`). Vnitřek
      // jednoho páru — průchod mřížkou — má vlastní mez v `sightBound`.
      return 2 * limits.maxSlots + limits.maxEntities + 2 * pairBound(limits);
    case 'trigger':
      // Každé pravidlo se vyhodnotí nejvýš jednou za tik.
      return limits.maxRules;
    case 'apply':
      // Spuštění pravidla stojí jednu jednotku klesajícího rozpočtu; efekty
      // jednoho pravidla se počítají proti témuž deklarovanému stropu.
      return limits.maxRuleFiringsPerTick * (1 + limits.maxRuleFiringsPerTick);
    case 'settle':
      // Časovače, příkazy pohybu a zmrazení — dvě smyčky, každá po entitách
      // a slotech.
      return 2 * settleItemBound(limits);
    default: {
      // Vyčerpanost přechodů kontroluje TypeScript při kompilaci. Kdyby do
      // `PHASES` přibyla pátá fáze bez `case`, tenhle řádek přestane přeložit.
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/**
 * Mez párové smyčky ve fázi `sense`. Odvozené fakty `overlapping` a `visible`
 * jsou nad dvojicemi entit, takže je to druhá mocnina deklarovaného počtu entit.
 */
export function pairBound(limits: IrLimits): number {
  return limits.maxEntities * limits.maxEntities;
}

/**
 * Mez jedné smyčky fáze `settle`. Časovače jsou sloty, příkazy pohybu a zmrazení
 * entity — obojí shora omezené deklarací, ne délkou fronty.
 */
export function settleItemBound(limits: IrLimits): number {
  return limits.maxEntities + limits.maxQueueDepth;
}

/**
 * Mez jednoho průchodu mřížkou. DDA jde po buňkách jedním směrem, takže se
 * nikdy nedotkne víc než `šířka + výška` buněk — i pro degenerovaný paprsek,
 * kde jsou obě entity ve stejné kvantované buňce.
 */
export function sightBound(limits: IrLimits): number {
  return limits.gridWidth + limits.gridHeight;
}

/**
 * Mez jednoho hledání cesty. Ohraničené prohledávání mřížky se nedotkne víc
 * buněk, než mřížka má.
 */
export function pathBound(limits: IrLimits): number {
  return limits.gridWidth * limits.gridHeight;
}
