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
 *
 * **Pořadí podle smyčky** (P36B T9): hry, které lidé dohrávají, posílají jako
 * výzvu a remixují, jdou výš (`byLoop`). Čítače se mezi dvěma stránkami smí
 * pohnout, a s nimi pořadí – stránka pak může zopakovat hru, kterou čtenář už
 * má (`FeedPager` ji zahodí), nebo minout hru, která mezitím stoupla nad jeho
 * pozici (uvidí ji při dalším načtení). Bez čítačů platí záruka výš beze změny.
 */

import { clearRate } from '@/play/loop-events';

import { diversify } from './diversify';
import { type LoopHeat, RECENT_CAP, type RecentGame } from './store';

/** Co feed o hře potřebuje vědět, aby rozhodl, jestli ji ukáže. */
export interface FeedCandidate {
  readonly versionId: string;
  readonly relation?: 'upgrade';
  /** Hra ze seedu feedu nebo z vestavěné sady (P37C T6); nese ji jen řádek seznamu. */
  readonly curated?: true;
  readonly publishEligible: boolean;
}

/**
 * Do feedu jen autorská verze od režiséra (`relation: 'upgrade'`) nebo hra ze
 * seedu provozovatele (`curated`, věty napsal on, ne návštěvník), která prošla
 * branou publikace a kterou provozovatel neskryl (`PLAY_FEED_HIDE`).
 */
export function feedEligible(game: FeedCandidate, hidden: ReadonlySet<string>): boolean {
  return game.publishEligible && (game.relation === 'upgrade' || game.curated === true) && !hidden.has(game.versionId);
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
  const cursor = { top: { createdAt, versionId }, offset };
  // Jen přesně ten zápis, který feed vydal: jiný zápis téhož kurzoru (`4e0`,
  // volné bity posledního znaku) by byl nový klíč cache hrany.
  return encodeCursor(cursor) === text ? cursor : null;
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

/** Každá `FRESH_EVERY`. pozice patří nejnovější hře, která ještě nebyla – nová hra bez historie tak dostane šanci. */
export const FRESH_EVERY = 3;

/** Útlum podle stáří: hra o den starší než nejnovější ve snímku má poloviční žár. */
const HALF_LIFE_MS = 24 * 3600 * 1000;

/**
 * Žár hry: dohrání, výzva a remix táhnou nahoru (výzva a remix víc – hráč hru
 * někomu ukázal), přeskočení dolů. P40 T5 – k čemu se lidi vrací:
 * - opakování `+1`: hráč si hru dal znovu, váží jako další dohrání (čítač je
 *   jeden hlas volajícího za den, takže na hráče jednou);
 * - sdílení `+2`: hru někomu poslal, ale je to slovo klienta, proto méně než
 *   výzva (`3`, server ji započte jen za uloženou vítěznou jízdu, sdílení k ní
 *   není potřeba) nebo remix (`3`, nová hra v úložišti);
 * - okamžitý odchod `−1`: hra nezaujala ani na první dotek. Odchod další hrou
 *   je zároveň přeskočení, takový dostane `−1,5` – víc než přeskočení po hraní.
 */
export function heatOf(heat: LoopHeat | undefined): number {
  if (heat === undefined) return 0;
  return Math.max(0, heat.finishes + heat.retries + 2 * heat.shares + 3 * heat.dares + 3 * heat.remixes - 0.5 * heat.skips - heat.bounces);
}

/** „N% beat this“ hry (P37C T5) z jejích čítačů; `null` = málo pokusů nebo čítače nejsou. */
export function beatOf(heat: LoopHeat | undefined): number | null {
  return heat === undefined ? null : clearRate(heat.starts, heat.clears);
}

/**
 * Pořadí podle smyčky. `rows` jdou od nejnovější. Stáří se měří proti
 * nejnovější hře snímku (`top`), ne proti hodinám – tentýž snímek a tytéž
 * čítače dají vždy totéž pořadí. Bez čítačů (žár všude 0) vyjde přesně
 * „od nejnovější“: obě fronty jsou pak tatáž.
 */
function byLoop(rows: readonly RecentGame[], heat: ReadonlyMap<string, LoopHeat>, top: FeedPosition): RecentGame[] {
  const topAt = Date.parse(top.createdAt);
  const score = new Map(rows.map((row) => [row.versionId, heatOf(heat.get(row.versionId)) * 0.5 ** ((topAt - Date.parse(row.createdAt)) / HALF_LIFE_MS)] as const));
  const hot = [...rows].sort((a, b) => (score.get(b.versionId) ?? 0) - (score.get(a.versionId) ?? 0) || newerFirst(a, b));
  const out: RecentGame[] = [];
  const placed = new Set<string>();
  const take = (queue: readonly RecentGame[]): RecentGame | undefined => queue.find((row) => !placed.has(row.versionId));
  while (out.length < rows.length) {
    const fresh = (out.length + 1) % FRESH_EVERY === 0;
    const next = (fresh ? take(rows) : take(hot)) as RecentGame;
    placed.add(next.versionId);
    out.push(next);
  }
  return out;
}

/**
 * Jedna stránka feedu ze všech řádků seznamu. Z jedné rodiny (autorské verze
 * téhož návrhu, tj. téhož `parentId`) jde jen nejnovější a z her se stejným
 * titulkem po normalizaci taky – takže se neopakují ani v jedné stránce, ani
 * napříč stránkami. `heat` (čítače smyčky) pak rozhodne pořadí (`byLoop`).
 */
export function feedPage(rows: readonly RecentGame[], limit: number, cursor: Cursor | null, hidden: ReadonlySet<string>, heat: ReadonlyMap<string, LoopHeat> = new Map()): FeedPage {
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
  const ranked = byLoop(shown, heat, top);
  const rank = new Map(ranked.map((row, index) => [row.versionId, index] as const));
  // `diversify` skončí, jakmile se do osmice nevejde žádná zbylá hra; zbytek
  // jde za ni v pořadí smyčky bez pravidla rozmanitosti, jinak by na žádné
  // stránce nebyl.
  const placed = diversify(ranked, Number.POSITIVE_INFINITY, (a, b) => (rank.get(a.versionId) ?? 0) - (rank.get(b.versionId) ?? 0));
  const inPlace = new Set(placed.map((row) => row.versionId));
  const all = [...placed, ...ranked.filter((row) => !inPlace.has(row.versionId))];
  const offset = cursor?.offset ?? 0;
  const end = offset + limit;
  return {
    games: all.slice(offset, end),
    next: end < all.length ? encodeCursor({ top: { createdAt: top.createdAt, versionId: top.versionId }, offset: end }) : null,
  };
}
