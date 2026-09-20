/**
 * Úložiště publikovaných verzí (P23-C T2) – **zapiš jednou, nikdy nepřepiš**.
 *
 * `versionId` je hash obsahu (`sealVersion`), takže pod jedním klíčem smí ležet
 * jen jedna hra. `put` proto píše `SET … NX` a když klíč už je, porovná uložené
 * bajty s těmi, které by napsal: shoda je `exists` (táž publikace podruhé),
 * neshoda `conflict` – a v obou případech zůstává v úložišti původní záznam.
 *
 * Dvě implementace nad jedním malým portem klíč → text: paměť procesu
 * (`next start`, testy) a REST Upstash z téhož obchodu, kde bydlí kniha stropu
 * (`sharedStoreFromEnv`, `storePrefix`). Klíče:
 *
 * - `<prefix>:play:v:<versionId>` – JSON celé `PublishedGame`,
 * - `<prefix>:play:children:<parentId>` – JSON pole id dětí,
 * - `<prefix>:play:lineage:<versionId>` – JSON pole `GameVersion` od kořene k listu.
 *
 * **Rodokmen se píše při publikaci, ne počítá při čtení.** Chůze po `parentId`
 * by stála jedno čtení na předka – až 32 příkazů na jeden `GET` z veřejných
 * dveří, na témž úložišti, kde bydlí kniha stropu (nález revize T3). Takhle je
 * publikace o dvě čtení dražší a čtení stojí jeden příkaz.
 *
 * Čtení nikdy nevyhazuje – neznámá hra i nedostupné úložiště jsou `null`.
 * Zápis při výpadku vyhazuje `VersionStoreUnavailable`, nikdy netvrdí
 * `stored`: publikace, o které se neví, jestli dorazila, není publikace.
 */

import { canonical } from '@/ir/worlddoc';
import { sharedStoreFromEnv, storePrefix } from '@/server/spend-store';

import type { GameVersion } from '../contracts';
import type { PublishedGame } from './version';

export interface VersionStore {
  readonly id: string;
  /** `null` je „neznámá hra“ – i když je to proto, že úložiště neodpovědělo nebo drží rozbitý záznam. */
  get(versionId: string): Promise<PublishedGame | null>;
  put(game: PublishedGame): Promise<'stored' | 'exists' | 'conflict'>;
  childrenOf(versionId: string): Promise<string[]>;
  /** Od kořene k listu, nejvýš `MAX_LINEAGE` nejnovějších záznamů. */
  lineageOf(versionId: string): Promise<GameVersion[]>;
}

export const MAX_LINEAGE = 32;

/** Kolik se čeká na sdílené úložiště; táž hodnota jako u knihy stropu. */
export const VERSION_STORE_TIMEOUT_MS = 2_000;

export class VersionStoreUnavailable extends Error {
  constructor(cause: unknown) {
    super(`version store unavailable: ${String(cause)}`);
    this.name = 'VersionStoreUnavailable';
  }
}

/** Port pod oběma implementacemi. `get` a `set` smí vyhazovat; překlad dělá vrstva nad nimi. */
interface RawStore {
  get(key: string): Promise<string | null>;
  /** `true`, když klíč ještě nebyl a zápis prošel. */
  setNx(key: string, value: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
}

/** Jediná serializace pro zápis: seřazené klíče, bez `undefined`. */
function serialise(game: PublishedGame): string {
  return canonical(game);
}

/**
 * Porovnání obsahu bez `createdAt`: `versionId` čas vzniku nenese, takže dvě
 * souběžné publikace téže hry se liší jen jím – to je `exists`, ne `conflict`.
 */
function sameContent(a: PublishedGame, b: PublishedGame): boolean {
  const strip = (game: PublishedGame): string => canonical({ ...game, version: { ...game.version, createdAt: '' } });
  return strip(a) === strip(b);
}

function versionStoreOver(id: string, prefix: string, raw: RawStore): VersionStore {
  const versionKey = (versionId: string): string => `${prefix}:play:v:${versionId}`;
  const childrenKey = (parentId: string): string => `${prefix}:play:children:${parentId}`;
  const lineageKey = (versionId: string): string => `${prefix}:play:lineage:${versionId}`;

  const store: VersionStore = {
    id,
    async get(versionId) {
      let text: string | null;
      try {
        text = await raw.get(versionKey(versionId));
      } catch {
        return null;
      }
      if (text === null) return null;
      try {
        return JSON.parse(text) as PublishedGame;
      } catch {
        return null;
      }
    },
    async put(game) {
      const key = versionKey(game.version.versionId);
      const text = serialise(game);
      try {
        if (!(await raw.setNx(key, text))) {
          const existing = await raw.get(key);
          if (existing === text) return 'exists';
          if (existing === null) return 'conflict';
          try {
            return sameContent(JSON.parse(existing) as PublishedGame, game) ? 'exists' : 'conflict';
          } catch {
            return 'conflict';
          }
        }
        const ancestors = game.version.parentId === null ? [] : await store.lineageOf(game.version.parentId);
        await raw.set(lineageKey(game.version.versionId), JSON.stringify([...ancestors, game.version].slice(-MAX_LINEAGE)));
        if (game.version.parentId !== null) {
          // Přečti, přidej, zapiš – bez zámku. Dvě děti publikovaná v téže
          // chvíli si můžou navzájem ztratit zápis; seznam dětí je navigace,
          // ne pravda o hře (ta je v `parentId` dítěte), a to je přijatelné.
          const childrenOfParent = childrenKey(game.version.parentId);
          const siblings = await raw.get(childrenOfParent);
          const list = siblings === null ? [] : (JSON.parse(siblings) as string[]);
          await raw.set(childrenOfParent, JSON.stringify([...list, game.version.versionId]));
        }
        return 'stored';
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
    },
    async childrenOf(versionId) {
      try {
        const text = await raw.get(childrenKey(versionId));
        return text === null ? [] : (JSON.parse(text) as string[]);
      } catch {
        return [];
      }
    },
    async lineageOf(versionId) {
      try {
        const text = await raw.get(lineageKey(versionId));
        if (text !== null) return (JSON.parse(text) as GameVersion[]).slice(-MAX_LINEAGE);
      } catch {
        return [];
      }
      // Verze bez rodokmenu: zápis rodokmenu za `SET NX` nedoběhl. Sama sobě je kořenem.
      const game = await store.get(versionId);
      return game === null ? [] : [game.version];
    },
  };
  return store;
}

export function memoryVersionStore(): VersionStore {
  const entries = new Map<string, string>();
  return versionStoreOver('memory', 'memory', {
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    setNx: (key, value) => {
      if (entries.has(key)) return Promise.resolve(false);
      entries.set(key, value);
      return Promise.resolve(true);
    },
    set: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
  });
}

export interface HttpVersionStoreConfig {
  /** Základ REST adresy úložiště. Bez koncového lomítka. */
  readonly url: string;
  readonly token: string;
  /** Táž předpona jako u knihy stropu. */
  readonly prefix: string;
  readonly timeoutMs: number;
}

/** Úložiště přes REST Upstash: `SET key value NX` a `SET key value` jedním příkazem, `GET` druhým. */
export function httpVersionStore(config: HttpVersionStoreConfig, fetchImpl: typeof fetch = fetch): VersionStore {
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };

  const command = async (parts: readonly string[]): Promise<unknown> => {
    const response = await fetchImpl(`${config.url}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(parts),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    // Bez těla odpovědi – chybová stránka úložiště nese adresu i klíč.
    if (!response.ok) throw new Error(`version store answered ${String(response.status)}`);
    return ((await response.json()) as { result?: unknown }).result;
  };

  return versionStoreOver('http', config.prefix, {
    async get(key) {
      const response = await fetchImpl(`${config.url}/get/${encodeURIComponent(key)}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`version store answered ${String(response.status)}`);
      const result = ((await response.json()) as { result?: unknown }).result;
      if (result === null || result === undefined) return null;
      if (typeof result !== 'string') throw new Error('version store answered a shape this server cannot read');
      return result;
    },
    setNx: async (key, value) => (await command(['SET', key, value, 'NX'])) === 'OK',
    async set(key, value) {
      await command(['SET', key, value]);
    },
  });
}

/** Jedno úložiště na proces, když se s nikým nesdílí. */
let processStore: VersionStore | null = null;

/** Jen pro testy. */
export function __resetProcessVersionStore(): void {
  processStore = null;
}

/** Sdílené úložiště podle prostředí (týž obchod a předpona jako kniha stropu), jinak paměť procesu. */
export function versionStoreFromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): VersionStore {
  const shared = sharedStoreFromEnv(env);
  if (shared !== null)
    return httpVersionStore({ url: shared.url, token: shared.token, prefix: storePrefix(env), timeoutMs: VERSION_STORE_TIMEOUT_MS }, fetchImpl);
  processStore ??= memoryVersionStore();
  return processStore;
}
