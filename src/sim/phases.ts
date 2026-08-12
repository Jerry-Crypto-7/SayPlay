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
 * Horní mez počtu **položek**, které fáze zpracuje. Není to mez práce — tu drží
 * rozpočet uvnitř primitiv (podmínka 5). Jsou to dvě různá tvrzení a plán je
 * odděluje schválně: „ohraničený počet kroků" a „ohraničená práce" se snadno
 * spletou a první z nich sama o sobě totalitu nedává.
 */
export function phaseBound(phase: Phase, limits: IrLimits): number {
  switch (phase) {
    case 'sense':
      // Odvozené fakty jsou párové (`overlapping`, `visible`), takže mez je
      // druhá mocnina počtu entit. Vnitřek jednoho páru — průchod mřížkou —
      // má vlastní mez v `sightBound`.
      return limits.maxEntities * limits.maxEntities;
    case 'trigger':
      // Každé pravidlo se vyhodnotí nejvýš jednou za tik.
      return limits.maxRules;
    case 'apply':
      // Spuštění pravidla stojí jednu jednotku klesajícího rozpočtu.
      return limits.maxRuleFiringsPerTick;
    case 'settle':
      // Časovače, příkazy pohybu a zmrazení — vše po entitách a slotech.
      return limits.maxEntities + limits.maxQueueDepth;
    default: {
      // Vyčerpanost přechodů kontroluje TypeScript při kompilaci. Kdyby do
      // `PHASES` přibyla pátá fáze bez `case`, tenhle řádek přestane přeložit.
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
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
