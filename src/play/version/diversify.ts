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
  readonly parentId: string | null;
  readonly relation?: 'upgrade';
}

/**
 * Návrh, jehož autorská verze už ve feedu je, se skryje – táž věta by jinak
 * visela ve feedu dvakrát. Autorská verze je lepší hra a odkaz na ni je týž zážitek.
 */
export function withoutUpgradedDrafts<Row extends FeedRow>(rows: readonly Row[]): Row[] {
  const upgraded = new Set(rows.flatMap((row) => (row.relation === 'upgrade' && row.parentId !== null ? [row.parentId] : [])));
  return rows.filter((row) => !upgraded.has(row.versionId));
}

export function diversify<Row extends FeedRow>(rows: readonly Row[], limit: number = Number.POSITIVE_INFINITY): Row[] {
  // Stabilní řazení od nejnovější; ISO čas se řadí jako text.
  const pending = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
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
