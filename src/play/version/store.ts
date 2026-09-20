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
 * - `<prefix>:play:children:<parentId>` – JSON pole id dětí.
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
  /** Od kořene k listu, nejvýš `MAX_LINEAGE` záznamů – tvrdý strop, aby cyklus skončil. */
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

/** Jediná serializace pro zápis i pro porovnání: seřazené klíče, bez `undefined`. */
function serialise(game: PublishedGame): string {
  return canonical(game);
}

function versionStoreOver(id: string, prefix: string, raw: RawStore): VersionStore {
  const versionKey = (versionId: string): string => `${prefix}:play:v:${versionId}`;
  const childrenKey = (parentId: string): string => `${prefix}:play:children:${parentId}`;

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
          return existing === text ? 'exists' : 'conflict';
        }
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
      const leafFirst: GameVersion[] = [];
      let cursor: string | null = versionId;
      while (cursor !== null && leafFirst.length < MAX_LINEAGE) {
        const game = await store.get(cursor);
        if (game === null) break;
        leafFirst.push(game.version);
        cursor = game.version.parentId;
      }
      return leafFirst.reverse();
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
