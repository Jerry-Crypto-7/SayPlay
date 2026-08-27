/**
 * Vstup hráče přeložený do záměru — kanonická mapa kláves.
 *
 * **Hra klávesnici nevidí.** Vidí `Intent`, a to je celý smysl téhle vrstvy:
 * stejný vstup jde poslat z testu, ze zaznamenané stopy i z prstu na klávese a
 * pokaždé projde touž cestou. Kdyby si smyčka četla `event.key` sama, nešlo by
 * ovládání ověřit jinak než prohlížečem, a scriptovaná stopa by přestala být
 * plnohodnotná náhrada člověka.
 *
 * Nic tu nezávisí na DOM: funkce bere **řetězec** `KeyboardEvent.key`, ne
 * událost. Volající si ji přečte sám a tenhle soubor se pak dá spustit v Node.
 *
 * **Tatáž mapa žije podruhé ve fallbacku** a je to vynucené, ne z lenosti:
 * fallback nesmí importovat z jádra (axiom architektonické nezávislosti) a
 * `npm run prove:fallback` to dokazuje studeným buildem ve stromu, ze kterého
 * bylo jádro fyzicky odstraněno. Obě kopie hlídá `__tests__/input.test.ts`,
 * který jako jediný smí sáhnout na obě — leží mimo skenovaný adresář.
 */

/**
 * Záměr hráče. Tvar je shodný s tím ve fallbacku a test to vynucuje.
 *
 * `point` a `drag` tu jsou proto, že je vyžadují archetypy, které se nehýbou po
 * mřížce (třídění do soketů). Klávesnice je dnes nevyrábí — vyrábí je ukazovací
 * zařízení — ale typ je jeden, aby hra měla jeden vstupní tvar, ne tři.
 */
export type Intent =
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'point'; readonly target: string }
  | { readonly kind: 'drag'; readonly from: string; readonly to: string };

/**
 * Klávesa → posun o jedno pole.
 *
 * `dy` roste **na sever**, stejně jako `FACINGS` ve smyčce fallbacku. Kdyby si
 * každá vrstva zvolila vlastní orientaci osy, poznalo by se to až u čtvrté hry.
 */
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

/** Klávesy, které něco dělají. Test nad nimi projde jednu po druhé. */
export const BOUND_KEYS: readonly string[] = Object.keys(MOVES);

/**
 * Záměr z klávesy, nebo `null`, když klávesa do hry nepatří.
 *
 * `null`, ne `{dx:0,dy:0}`: nulový pohyb by prošel do kroku hry jako pohyb a
 * spotřeboval tik. „Tohle není vstup do hry" a „hráč se pokusil nikam nejít"
 * jsou dvě různé věci a jen jedna z nich se má dostat dovnitř.
 *
 * Velká písmena se srovnávají dolů: se zapnutým Shiftem nebo Caps Lockem se hra
 * nesmí zaseknout.
 */
export function intentFromKey(key: string): Intent | null {
  const move = MOVES[key] ?? MOVES[key.toLowerCase()];
  return move === undefined ? null : { kind: 'move', dx: move[0], dy: move[1] };
}
