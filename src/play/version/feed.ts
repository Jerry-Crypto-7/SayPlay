/**
 * Stránkovaný feed na `/play` (P27B T2) – kontrakt v `docs/play/feed.md`.
 *
 * **Kdo smí do feedu** říká jen `feedEligible`, odděleně od „lze otevřít
 * odkazem“: skrytá nebo nezpůsobilá hra ve feedu chybí, její odkaz dál platí.
 *
 * **Stránky se nepřekrývají ani nic nepřeskočí** díky snímku: první stránka si
 * zapamatuje nejnovější řádek seznamu (`top`) a kurzor nese jen `top` a počet
 * už vydaných her. Každá další stránka počítá tentýž seřazený a rozmanitý
 * seznam ze řádků nejvýš po `top` – hra publikovaná mezi dvěma dotazy leží nad
 * `top` a pořadí pod ním nepohne. Posun umí jen to, co ze seznamu odpadne na
 * konci (expirace, strop `RECENT_CAP`), a to jsou nejstarší hry.
 */

import { diversify } from './diversify';
import { RECENT_CAP, type RecentGame } from './store';

/** Co feed o hře potřebuje vědět, aby rozhodl, jestli ji ukáže. */
export interface FeedCandidate {
  readonly versionId: string;
  readonly relation?: 'upgrade';
  readonly publishEligible: boolean;
}

/**
 * Do feedu jen autorská verze od režiséra (`relation: 'upgrade'`), která prošla
 * branou publikace a kterou provozovatel neskryl (`PLAY_FEED_HIDE`).
 */
export function feedEligible(game: FeedCandidate, hidden: ReadonlySet<string>): boolean {
  return game.publishEligible && game.relation === 'upgrade' && !hidden.has(game.versionId);
}

/** `PLAY_FEED_HIDE` – čárkami oddělená `versionId`; mezery a prázdné položky se ignorují. */
export function hiddenFromEnv(env: Record<string, string | undefined>): ReadonlySet<string> {
  return new Set((env.PLAY_FEED_HIDE ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''));
}

interface Cursor {
  readonly top: { readonly createdAt: string; readonly versionId: string };
  readonly offset: number;
}

/**
 * Kontrolní součet kurzoru (FNV-1a, 32 bitů). Není to podpis – kdo čte kód,
 * součet spočítá; jen náhodný nebo upravený kurzor neprojde dřív, než se čte
 * seznam, a vyhne se tak i 15s cache hrany. Odhodlaného volajícího drží `admit()`.
 */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Kurzor je neprůhledný: base64url JSONu se součtem. Klient ho jen vrací. */
export function encodeCursor(cursor: Cursor): string {
  const fields = [cursor.top.createdAt, cursor.top.versionId, cursor.offset];
  return Buffer.from(JSON.stringify([...fields, checksum(JSON.stringify(fields))])).toString('base64url');
}

/** `null` = poškozený kurzor; dveře odpoví 400. */
export function decodeCursor(text: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [createdAt, versionId, offset, sum] = value as unknown[];
  if (sum !== checksum(JSON.stringify([createdAt, versionId, offset]))) return null;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (typeof versionId !== 'string' || !/^[a-f0-9]{8,64}$/.test(versionId)) return null;
  // Poctivý kurzor ukazuje dovnitř seznamu, který má nejvýš `RECENT_CAP` řádků.
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1 || offset >= RECENT_CAP) return null;
  return { top: { createdAt, versionId }, offset };
}

/** Od nejnovější; shodný čas rozhodne `versionId`, aby pořadí bylo úplné. */
function newerFirst(a: FeedPosition, b: FeedPosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.versionId < b.versionId ? 1 : a.versionId > b.versionId ? -1 : 0;
}

interface FeedPosition {
  readonly createdAt: string;
  readonly versionId: string;
}

/** Titulek pro porovnání: malá písmena, bez interpunkce, jedna mezera. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export interface FeedPage {
  readonly games: RecentGame[];
  readonly next: string | null;
}

/**
 * Jedna stránka feedu ze všech řádků seznamu. Z jedné rodiny (autorské verze
 * téhož návrhu, tj. téhož `parentId`) jde jen nejnovější a z her se stejným
 * titulkem po normalizaci taky – takže se neopakují ani v jedné stránce, ani
 * napříč stránkami.
 */
export function feedPage(rows: readonly RecentGame[], limit: number, cursor: Cursor | null, hidden: ReadonlySet<string>): FeedPage {
  const sorted = [...rows].sort(newerFirst);
  const top = cursor?.top ?? sorted[0];
  if (top === undefined) return { games: [], next: null };
  const families = new Set<string>();
  const titles = new Set<string>();
  const shown = sorted.filter((row) => {
    if (newerFirst(row, top) < 0) return false;
    // Řádek seznamu zapsala jen způsobilá publikace (`put`); tady rozhoduje skrytí a relace.
    if (!feedEligible({ ...row, publishEligible: true }, hidden)) return false;
    const family = row.parentId ?? row.versionId;
    const title = titleKey(row.title);
    if (families.has(family) || titles.has(title)) return false;
    families.add(family);
    titles.add(title);
    return true;
  });
  // `diversify` skončí, jakmile se do osmice nevejde žádná zbylá hra; zbytek
  // jde za ni od nejnovější bez pravidla rozmanitosti, jinak by na žádné
  // stránce nebyl.
  const placed = diversify(shown);
  const inPlace = new Set(placed.map((row) => row.versionId));
  const all = [...placed, ...shown.filter((row) => !inPlace.has(row.versionId))];
  const offset = cursor?.offset ?? 0;
  const end = offset + limit;
  return {
    games: all.slice(offset, end),
    next: end < all.length ? encodeCursor({ top: { createdAt: top.createdAt, versionId: top.versionId }, offset: end }) : null,
  };
}
