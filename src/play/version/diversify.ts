/**
 * Rozmanitost feedu na `/play` (P23-D T4).
 *
 * Feed je řazený od nejnovější hry, ale osm honiček za sebou vypadá jako
 * feed s jednou hrou. Proto v každé zarovnané osmici (pozice 0–7, 8–15, …)
 * nejvýš `MAX_PER_ARCHETYPE` her téhož archetypu. Hra, která se do osmice
 * nevejde, se odloží do další; když se do rozpracované osmice nevejde žádná
 * zbylá hra, feed tam končí – kratší feed je poctivější než osmice, která
 * pravidlo poruší.
 */

export const FEED_BLOCK = 8;
export const MAX_PER_ARCHETYPE = 3;

export interface FeedRow {
  readonly versionId: string;
  readonly archetype: string;
  readonly createdAt: string;
}

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
    const index = pending.findIndex((row) => (block.get(row.archetype) ?? 0) < MAX_PER_ARCHETYPE);
    if (index === -1) break;
    const [row] = pending.splice(index, 1);
    block.set(row.archetype, (block.get(row.archetype) ?? 0) + 1);
    out.push(row);
  }
  return out;
}
