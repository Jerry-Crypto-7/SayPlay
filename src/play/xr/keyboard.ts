/**
 * Klávesnice VR lobby (P67 T2): QWERTY, na kterou hráč míří paprskem pravého ovladače a píše spouští. DOM pole
 * v immersive relaci vidět není a systémová klávesnice Questu se do WebXR relace nevolá, proto si ji hra kreslí sama
 * (`XrKeyboard.tsx`). Tady je jen rozložení a co stisk udělá s větou – bez React a bez three, ať se dá testovat.
 *
 * Každá řada má deset kláves, takže klávesy mají jednu šířku a celá klávesnice je jedna mřížka panelu. Mezera,
 * mazání a „Done“ jsou širší tlačítka pod ní.
 */

/** Řady kláves odshora: číslice („for 60 seconds“), QWERTY a interpunkce, kterou věty karet nápadů používají. */
export const KEY_ROWS = ['1234567890', 'qwertyuiop', "asdfghjkl'", 'zxcvbnm,.-'] as const;

/** Kláves v řadě. */
export const KEY_COLUMNS = 10;

export type KeyPress = { readonly kind: 'char'; readonly char: string } | { readonly kind: 'space' } | { readonly kind: 'delete' };

/**
 * Věta po stisku klávesy. `limit` je strop věty (`SENTENCE_LIMIT`): nad ním znak ani mezera nepřibude, smazat jde
 * vždy. Mezera nikdy na začátku a nikdy dvě za sebou – „Make it!“ posílá větu oříznutou a dvojitou mezeru by
 * hráč na panelu ani neviděl. První písmeno věty je velké, jako u karet nápadů.
 */
export function typed(text: string, key: KeyPress, limit: number): string {
  if (key.kind === 'delete') return text.slice(0, -1);
  if (text.length >= limit) return text;
  if (key.kind === 'space') return text === '' || text.endsWith(' ') ? text : `${text} `;
  return text + (text === '' ? key.char.toUpperCase() : key.char);
}
