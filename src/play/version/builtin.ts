/**
 * Vestavěná sada her (P37C T6): ověřené hry v buildu, aby feed nikdy nebyl
 * prázdný – ani na čisté instanci bez Upstash, ani s prázdným úložištěm.
 *
 * Hry staví `scripts/p37c/seed-feed.mjs --builtin` z vět feedu (od P70C T4 dvě
 * na každý hratelný žánr) stejnou cestou jako `POST /api/play/games` (návrh ze
 * slov, robot ji vyhraje, nečinný hráč prohraje, náhled robota se hýbe) a řadí
 * je podle hloubky, prokládané po žánrech. Věty napsal provozovatel, ne
 * návštěvník – proto smí do feedu i bez autorské verze.
 *
 * Do feedu jde jen `FEED_GAMES`: hry feedu a nejvýš čtyři staré hry „choď a
 * sbírej“ ze zmrazené sady (`builtin-feed-old.json`). Ostatní zmrazené hry feed
 * neukáže, ale jejich odkazy dál platí (`get`, `lineageOf`).
 *
 * Obal úložiště hry z úložiště nijak nemění; jen doplní, co úložiště nemá:
 * - `recent` – za uložené řádky přidá vestavěné z feedu, které v nich nejsou, do `limit`;
 *   plné úložiště je tak vytlačí, prázdné ukáže jen je;
 * - `get` a `lineageOf` – odkaz na vestavěnou hru, výzva i remix fungují;
 * - `countLoop`, `put` a `feature` – vestavěnou hru (hru události, rodiče
 *   remixu nebo autorské verze) nejdřív uloží, aby se čítače (dohrání, výzvy,
 *   „N % beat this“) počítaly jako u každé jiné hry a dítě dostalo celý
 *   rodokmen – `put` ho skládá z rodokmenu rodiče v úložišti (nález revize T6-1 #1).
 *   Do denního stropu publikací se vestavěná hra nepočítá (`put` v `store.ts`).
 */

import type { GameVersion } from '../contracts';
import feedOld from './builtin-feed-old.json';
import feedBuiltin from './builtin-feed-games.json';
import builtin from './builtin-games.json';
import { feedRowOf, type VersionStore } from './store';
import type { PublishedGame } from './version';

const FROZEN = builtin as unknown as readonly PublishedGame[];
const FEED_BUILT = feedBuiltin as unknown as readonly PublishedGame[];

/**
 * Zmrazená sada P37C (`builtin-games.json`, světy `arcade-v2` zamčené `legacy-replay-v2`) a hry feedu
 * z dnešního jádra (`builtin-feed-games.json`); obě s náhledem robota (`preview`).
 */
export const BUILTIN_GAMES: readonly PublishedGame[] = [...FROZEN, ...FEED_BUILT];

/** Id vestavěných her – `put` je nepočítá do denního stropu publikací návštěvníků. */
export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_GAMES.map((game) => game.version.versionId));

/** Staré hry „choď a sbírej“ ze zmrazené sady, které feed ještě ukáže – vybírá je `seed-feed.mjs --builtin` (`oldWalkInFeed`). */
const OLD_IN_FEED: ReadonlySet<string> = new Set(feedOld);

/** Vestavěné hry, které feed ukáže: hry feedu (dvě na hratelný žánr) a nejvýš čtyři staré. */
export const FEED_GAMES: readonly PublishedGame[] = [...FEED_BUILT, ...FROZEN.filter((game) => OLD_IN_FEED.has(game.version.versionId))];

export function withBuiltinGames(inner: VersionStore, games: readonly PublishedGame[] = BUILTIN_GAMES, feed: readonly PublishedGame[] = FEED_GAMES): VersionStore {
  const byId = new Map(games.map((game) => [game.version.versionId, game]));
  const rows = feed.map((game) => ({ ...feedRowOf(game), curated: true as const }));
  /**
   * Vestavěnou hru uloží, chybí-li v úložišti. Výpadek vyhodí `VersionStoreUnavailable` z `put` –
   * dítě se pak neuloží s useknutým rodokmenem (nález revize T6-2 #1). Bez paměti uložených: hra
   * v úložišti vyprší a další událost ji musí uložit znovu (nález revize T6-2 #2); stojí to jedno čtení.
   */
  const materialise = async (versionId: string | null): Promise<void> => {
    const game = versionId === null ? undefined : byId.get(versionId);
    if (game !== undefined && (await inner.get(game.version.versionId)) === null) await inner.put(game);
  };
  return {
    ...inner,
    async put(game) {
      await materialise(game.version.parentId);
      return inner.put(game);
    },
    async feature(game) {
      await materialise(game.version.parentId);
      return inner.feature(game);
    },
    async get(versionId) {
      return (await inner.get(versionId)) ?? byId.get(versionId) ?? null;
    },
    async lineageOf(versionId): Promise<GameVersion[]> {
      const stored = await inner.lineageOf(versionId);
      const game = byId.get(versionId);
      return stored.length > 0 || game === undefined ? stored : [game.version];
    },
    async recent(limit) {
      const stored = await inner.recent(limit);
      const had = new Set(stored.map((row) => row.versionId));
      // Remixy až za vestavěnou sadou (nález revize T10-1 #2): jejich řádky nevytlačí kurátorské hry.
      const remixes = stored.filter((row) => row.relation === 'remix');
      return [...stored.filter((row) => row.relation !== 'remix'), ...rows.filter((row) => !had.has(row.versionId)), ...remixes].slice(0, limit);
    },
    async countLoop(versionId, counters, voter) {
      try {
        await materialise(versionId);
      } catch {
        // Čítač je navíc – bez uložené hry ho `countLoop` nezapočte a příští událost to zkusí znovu.
      }
      await inner.countLoop(versionId, counters, voter);
    },
  };
}
