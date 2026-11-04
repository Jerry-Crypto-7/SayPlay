/**
 * Rozmanitost feedu na `/play` (P23-D T4, podle žánru od P70C T4).
 *
 * Feed je řazený od nejnovější hry, ale osm honiček za sebou vypadá jako
 * feed s jednou hrou. Proto v každé zarovnané osmici (pozice 0–7, 8–15, …)
 * nejvýš `MAX_PER_GENRE` her téhož druhu (`feedKindOf`). Hra, která se do
 * osmice nevejde, se odloží do další; když se do rozpracované osmice nevejde
 * žádná zbylá hra, feed tam končí – kratší feed je poctivější než osmice, která
 * pravidlo poruší.
 */

import type { GameSpecV1 } from '../spec';

export const FEED_BLOCK = 8;
/** Majitel 4. 11.: „feed tam je jen jeden druh her“ – nejvýš dvě hry téhož žánru v osmici. */
export const MAX_PER_GENRE = 2;

export interface FeedRow {
  readonly versionId: string;
  readonly archetype: string;
  /** Druh hry (`feedKindOf`); řádek seznamu zapsaný před P70C T4 ho nemá a počítá se podle archetypu. */
  readonly genre?: string;
  readonly createdAt: string;
}

/**
 * Druh hry pro rozmanitost: žánr (`spec.genre.id`), u hry bez žánru její ovládání. Žánr nezapisují nativní
 * sestavy (plachtění, řízení, chodec bludištěm) ani hry před P32 – jejich ovládání je to, co hráč na kartě pozná.
 * Spec bez ovládání (mřížka archetypu před P27) má jen archetyp.
 */
export function feedKindOf(spec: Pick<GameSpecV1, 'genre' | 'control' | 'archetype'>): string {
  return spec.genre?.id ?? spec.control ?? spec.archetype;
}

const kindOf = (row: FeedRow): string => row.genre ?? row.archetype;

/** Výchozí pořadí: od nejnovější; ISO čas se řadí jako text. */
const newestFirst = (a: FeedRow, b: FeedRow): number => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** `order` – pořadí, ve kterém hry osmice berou (feed řazený podle smyčky, P36B T9, dává vlastní). */
export function diversify<Row extends FeedRow>(rows: readonly Row[], limit: number = Number.POSITIVE_INFINITY, order: (a: Row, b: Row) => number = newestFirst): Row[] {
  // Stabilní řazení.
  const pending = [...rows].sort(order);
  const out: Row[] = [];
  let block = new Map<string, number>();
  while (out.length < limit && pending.length > 0) {
    if (out.length % FEED_BLOCK === 0) block = new Map();
    const index = pending.findIndex((row) => (block.get(kindOf(row)) ?? 0) < MAX_PER_GENRE);
    if (index === -1) break;
    const [row] = pending.splice(index, 1);
    block.set(kindOf(row), (block.get(kindOf(row)) ?? 0) + 1);
    out.push(row);
  }
  return out;
}
