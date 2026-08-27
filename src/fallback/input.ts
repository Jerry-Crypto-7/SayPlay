/**
 * Klávesa → `Intent` pro fallback.
 *
 * **Tenhle soubor je vědomá kopie.** Táž mapa žije i v jádře, a nesdílí se ze
 * stejného důvodu, ze kterého si fallback duplikuje generátor náhodných streamů
 * (viz hlavička `loop.ts`): axiom architektonické nezávislosti zakazuje
 * fallbacku importovat cokoliv z modulů jádra, a `npm run prove:fallback` to
 * dokazuje studeným buildem ve stromu, ze kterého bylo jádro fyzicky
 * odstraněno. Sdílený modul by znamenal, že fallback spadne se stejnou
 * komponentou, proti jejímuž selhání má pojistit.
 *
 * Cesty do jádra se tu **nepíšou v úplném tvaru** — AC úlohy T202 je doslovný
 * grep nad `src/fallback` a poznámka o zákazu by ho shodila stejně jako
 * skutečný import.
 *
 * Rozejít se ty dvě kopie nesmí a hlídá to strojově `input.test.ts` v testech
 * jádra: leží mimo skenovaný adresář, takže smí sáhnout na obě naráz a porovnat
 * je klávesu po klávese.
 */

import type { Intent } from './loop';

/** `dy` roste na sever, shodně s `FACINGS` v `loop.ts`. */
const MOVES: Readonly<Record<string, readonly [number, number]>> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  d: [1, 0],
  a: [-1, 0],
  w: [0, 1],
  s: [0, -1],
};

export const BOUND_KEYS: readonly string[] = Object.keys(MOVES);

/**
 * Záměr z klávesy, nebo `null` pro klávesu, která do hry nepatří.
 *
 * `null`, ne nulový pohyb: `advance` bere `{dx:0,dy:0}` jako pokus o pohyb a
 * spotřeboval by na něj tik.
 */
export function intentFromKey(key: string): Intent | null {
  const move = MOVES[key] ?? MOVES[key.toLowerCase()];
  return move === undefined ? null : { kind: 'move', dx: move[0], dy: move[1] };
}
