'use client';

/**
 * 3D klávesnice VR lobby (P67 T2): mřížka kláves `KEY_ROWS` na kartě kitu (`XrPanel`), pod ní mezera, mazání
 * a „Done“. Hráč míří paprskem pravého ovladače a píše spouští; co stisk udělá s větou, rozhoduje `typed`
 * (`src/play/xr/keyboard.ts`). Náhled věty a počítadlo nese karta lobby nad klávesnicí (`XrLobby`), ať jsou
 * u „Make it!“.
 */

import { KEY_COLUMNS, KEY_ROWS, type KeyPress } from '@/play/xr/keyboard';

import type { PanelSpec } from './XrPanel';

export const SPACE = 'Space';
export const DELETE = 'Delete';
export const DONE = 'Done';

/** Šířka karty v px kitu – jako karta lobby nad ní; klávesa vyjde na ~43 px, kolem minima kitu 44. */
export const KEYBOARD_WIDTH = 520;
/** Mezera mezi klávesami (px kitu). */
const KEY_GAP = 6;

/** Karta klávesnice; `onKey` dostane každý stisk, `onDone` ji zavře. */
export function keyboardOf(onKey: (key: KeyPress) => void, onDone: () => void): PanelSpec {
  return {
    id: 'keyboard',
    width: KEYBOARD_WIDTH,
    grid: {
      columns: KEY_COLUMNS,
      gap: KEY_GAP,
      cells: KEY_ROWS.flatMap((row) => [...row].map((char) => ({ id: `key-${char}`, label: char, press: () => onKey({ kind: 'char', char }) }))),
    },
    buttons: [
      { id: 'space', label: SPACE, press: () => onKey({ kind: 'space' }) },
      { id: 'delete', label: DELETE, press: () => onKey({ kind: 'delete' }) },
      { id: 'done', label: DONE, press: onDone },
    ],
  };
}
