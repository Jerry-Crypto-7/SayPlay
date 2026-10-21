/**
 * Rozvržení mřížkových listů pro slepou kontrolu knihovny (P43 T10).
 *
 * Jeden list nese `size × size` modelů, buňky číslované 1…n po řádcích.
 * Pořadí je podle `assetId`, takže stejný katalog dá vždy stejné listy a
 * verdikt z buňky jde zpět na model jen přes `grid-index.json` – v obraze
 * žádné jméno ani cesta není.
 */

/**
 * `[{ sheet: 'grid-001', cells: [assetId, …] }]` pro celý katalog. `keepOrder` (P57 T3) nechá
 * pořadí, jak přišlo (nejpoužívanější modely na prvních listech); listy se jmenují dál jen číslem.
 */
export function gridPlan(assets, size, { keepOrder = false } = {}) {
  const perSheet = size * size;
  const ids = assets.map((asset) => asset.assetId);
  if (!keepOrder) ids.sort();
  const sheets = [];
  for (let start = 0; start < ids.length; start += perSheet) {
    sheets.push({ sheet: `grid-${String(sheets.length + 1).padStart(3, '0')}`, cells: ids.slice(start, start + perSheet) });
  }
  return sheets;
}

/** Levý horní roh buňky `cell` (od 0) v pixelech listu. */
export const cellOrigin = (cell, size, cellPx) => ({ x: (cell % size) * cellPx, y: Math.floor(cell / size) * cellPx });
