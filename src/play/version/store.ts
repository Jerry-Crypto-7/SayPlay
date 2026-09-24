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
 * - `<prefix>:play:lineage:<versionId>` – JSON pole `GameVersion` od kořene k listu,
 * - `<prefix>:play:recent` – seznam `RecentGame` od nejnovější, nejvýš `RECENT_CAP` (feed, P23-D T4).
 *
 * **Rodokmen se píše při publikaci, ne počítá při čtení.** Chůze po `parentId`
 * by stála jedno čtení na předka – až 32 příkazů na jeden `GET` z veřejných
 * dveří, na témž úložišti, kde bydlí kniha stropu (nález revize T3). Takhle je
 * publikace o dvě čtení dražší a čtení stojí jeden příkaz.
 *
 * **Zápisy mají strop a expiraci** (nález bezpečnostní revize 20. 9. 2026):
 * publikace jsou anonymní, a bez meze by jeden volající zaplnil kvótu obchodu,
 * o který se dělí kniha stropu – ta pak selhává zavřeně a placená cesta modelu
 * umře. Každý klíč hry dostane `EX <ttl>` a denní počítadlo
 * `<prefix>:play:quota:<den>` zastaví publikace nad `dailyCap` (`quota`).
 *
 * Čtení nikdy nevyhazuje – neznámá hra i nedostupné úložiště jsou `null`.
 * Zápis při výpadku vyhazuje `VersionStoreUnavailable`, nikdy netvrdí
 * `stored`: publikace, o které se neví, jestli dorazila, není publikace.
 */

import { canonical } from '@/ir/worlddoc';
import { sharedStoreFromEnv, storePrefix } from '@/server/spend-store';

import type { GameVersion } from '../contracts';
import { feedEligible } from './feed';
import type { PublishedGame } from './version';

/** Skrytí platí až při čtení feedu (`PLAY_FEED_HIDE`); zápis do seznamu ho nezná. */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

export interface VersionStore {
  readonly id: string;
  /** `null` je „neznámá hra“ – i když je to proto, že úložiště neodpovědělo nebo drží rozbitý záznam. */
  get(versionId: string): Promise<PublishedGame | null>;
  /** `quota` = denní strop publikací vyčerpán; nic se nezapsalo. */
  put(game: PublishedGame): Promise<PutOutcome>;
  /**
   * Zbývá dnes na publikaci? Jen čte počítadlo, nic nezapočítá – dveře se ptají
   * dřív, než kvůli publikaci zaplatí model. Výpadek úložiště je `VersionStoreUnavailable`.
   */
  canPublish(): Promise<boolean>;
  /**
   * Započte jedno placené volání režiséra volajícímu na dnešek; `false` = byl
   * by nad `limit` (R8). Denní počítadlo leží vedle kvóty publikací, sdílené
   * napříč instancemi. Výpadek úložiště je `VersionStoreUnavailable`.
   */
  takeDirectorCall(caller: string, limit: number): Promise<boolean>;
  /**
   * Proč návrh zůstal návrhem, když to už jednou někdo spočítal (R10); `null`
   * = neví se, i při výpadku úložiště. Zápis výpadek spolkne – nejhůř se
   * režie zaplatí znovu, jako před R10.
   */
  upgradeVerdict(draftId: string): Promise<string | null>;
  rememberUpgradeVerdict(draftId: string, reason: string, ttlSeconds: number): Promise<void>;
  childrenOf(versionId: string): Promise<string[]>;
  /** Od kořene k listu, nejvýš `MAX_LINEAGE` nejnovějších záznamů. */
  lineageOf(versionId: string): Promise<GameVersion[]>;
  /**
   * Nejnovější autorské verze (`relation: 'upgrade'`, `publishEligible`), od
   * nejnovější, bez vypršelých; nedostupné úložiště je `[]`.
   */
  recent(limit: number): Promise<RecentGame[]>;
  /** Počet dětí každé verze, jedním čtením; nedostupné úložiště jsou nuly. */
  childCounts(versionIds: readonly string[]): Promise<number[]>;
}

/** Řádek feedu: verze plus to, co karta ukáže a co feed potřebuje k rozmanitosti. */
export interface RecentGame extends GameVersion {
  readonly archetype: string;
  readonly relation: 'upgrade';
}

/** Kolik publikací si feed pamatuje. */
export const RECENT_CAP = 200;

export type PutOutcome = 'stored' | 'exists' | 'conflict' | 'quota';

export const MAX_LINEAGE = 32;

/** Meze zápisu; `versionStoreFromEnv` je čte z `PLAY_VERSION_TTL_SECONDS` a `PLAY_PUBLISH_DAILY_CAP`. */
export interface WriteLimits {
  /**
   * Jak dlouho hra žije od publikace. Výchozí 180 dní: porota otvírá odkazy týdny
   * po odevzdání a se 60 dny by hra vytvořená 24. 9. 2026 zmizela 23. 11., dva dny
   * před vyhlášením 25. 11. Rezerva pokryje i hry publikované po odevzdání.
   */
  readonly ttlSeconds: number;
  /** Kolik publikací (pokusů o zápis) za den napříč všemi volajícími; autorská dítě (`relation: 'upgrade'`) se nepočítají. */
  readonly dailyCap: number;
}

export const DEFAULT_WRITE_LIMITS: WriteLimits = { ttlSeconds: 180 * 24 * 3600, dailyCap: 500 };

/** Den v UTC pro klíč počítadla. */
function quotaDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

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
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Zvýší počítadlo a vrátí novou hodnotu; klíč vyprší po `ttlSeconds` od prvního zvýšení. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Přidá na začátek seznamu a usekne ho na `cap` položek. */
  pushCapped(key: string, value: string, cap: number, ttlSeconds: number): Promise<void>;
  /** Prvních `count` položek seznamu. */
  head(key: string, count: number): Promise<string[]>;
  /** Hodnoty klíčů v témž pořadí, chybějící jako `null`. */
  getMany(keys: readonly string[]): Promise<(string | null)[]>;
}

/** Jediná serializace pro zápis: seřazené klíče, bez `undefined`. */
function serialise(game: PublishedGame): string {
  return canonical(game);
}

/**
 * Porovnání obsahu bez `createdAt` a `timings`: `versionId` čas vzniku ani
 * naměřené časy nenese, takže dvě souběžné publikace téže hry se liší jen jimi
 * – to je `exists`, ne `conflict`.
 */
function sameContent(a: PublishedGame, b: PublishedGame): boolean {
  const strip = (game: PublishedGame): string => canonical({ ...game, timings: undefined, version: { ...game.version, createdAt: '' } });
  return strip(a) === strip(b);
}

function versionStoreOver(id: string, prefix: string, raw: RawStore, limits: WriteLimits, now: () => number): VersionStore {
  const versionKey = (versionId: string): string => `${prefix}:play:v:${versionId}`;
  const childrenKey = (parentId: string): string => `${prefix}:play:children:${parentId}`;
  const lineageKey = (versionId: string): string => `${prefix}:play:lineage:${versionId}`;
  const quotaKey = (): string => `${prefix}:play:quota:${quotaDay(now())}`;
  const recentKey = `${prefix}:play:recent`;
  const verdictKey = (draftId: string): string => `${prefix}:play:upgrade-final:${draftId}`;

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
        // Autorské dítě se do kvóty nepočítá (R11): stojí placené volání a drží
        // ho strop utrácení a denní počet volajícího. Jinak by věta zapsala dvě
        // hry a strop by pustil jen polovinu vět.
        if (game.relation !== 'upgrade' && (await raw.incr(quotaKey(), 2 * 24 * 3600)) > limits.dailyCap) return 'quota';
        if (!(await raw.setNx(key, text, limits.ttlSeconds))) {
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
        await raw.set(lineageKey(game.version.versionId), JSON.stringify([...ancestors, game.version].slice(-MAX_LINEAGE)), limits.ttlSeconds);
        if (game.version.parentId !== null) {
          // Přečti, přidej, zapiš – bez zámku. Dvě děti publikovaná v téže
          // chvíli si můžou navzájem ztratit zápis; seznam dětí je navigace,
          // ne pravda o hře (ta je v `parentId` dítěte), a to je přijatelné.
          const childrenOfParent = childrenKey(game.version.parentId);
          const siblings = await raw.get(childrenOfParent);
          const list = siblings === null ? [] : (JSON.parse(siblings) as string[]);
          await raw.set(childrenOfParent, JSON.stringify([...list, game.version.versionId]), limits.ttlSeconds);
        }
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
      // Do feedu jen autorská verze od režiséra (nález revize T4-1): titul
      // ručního specu, remixu i návrhu ze slov píše volající, a feed by ho
      // zdarma ukázal každému návštěvníkovi `/play`. Autorská verze stojí
      // placené volání pod stropy a titul jí napsal model.
      if (feedEligible({ versionId: game.version.versionId, relation: game.relation, publishEligible: game.report.publishEligible }, NOTHING_HIDDEN)) {
        const row: RecentGame = { ...game.version, archetype: game.spec.archetype, relation: 'upgrade' };
        try {
          await raw.pushCapped(recentKey, JSON.stringify(row), RECENT_CAP, limits.ttlSeconds);
        } catch {
          // Feed je navigace: hra je uložená a odkaz na ni platí, i když se do feedu nedostala.
        }
      }
      return 'stored';
    },
    async canPublish() {
      let text: string | null;
      try {
        text = await raw.get(quotaKey());
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
      return text === null || Number(text) < limits.dailyCap;
    },
    async takeDirectorCall(caller, limit) {
      try {
        return (await raw.incr(`${prefix}:play:director:${quotaDay(now())}:${caller}`, 2 * 24 * 3600)) <= limit;
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
    },
    async upgradeVerdict(draftId) {
      try {
        return await raw.get(verdictKey(draftId));
      } catch {
        return null;
      }
    },
    async rememberUpgradeVerdict(draftId, reason, ttlSeconds) {
      try {
        await raw.set(verdictKey(draftId), reason, ttlSeconds);
      } catch {
        // Viz `upgradeVerdict`.
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
    async recent(limit) {
      try {
        const rows = await raw.head(recentKey, Math.min(limit, RECENT_CAP));
        // Seznam žije od poslední publikace, hra od své – vypršelá hra by vedla na 404.
        const oldest = now() - limits.ttlSeconds * 1000;
        return rows.flatMap((text) => {
          try {
            const row = JSON.parse(text) as RecentGame;
            return Date.parse(row.createdAt) > oldest ? [row] : [];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    },
    async childCounts(versionIds) {
      if (versionIds.length === 0) return [];
      try {
        const texts = await raw.getMany(versionIds.map(childrenKey));
        return texts.map((text) => {
          if (text === null) return 0;
          try {
            return (JSON.parse(text) as string[]).length;
          } catch {
            return 0;
          }
        });
      } catch {
        return versionIds.map(() => 0);
      }
    },
  };
  return store;
}

/** Paměť procesu neexpiruje – drží ji denní strop, a `next start` žije kratší dobu než TTL. */
export function memoryVersionStore(limits: WriteLimits = DEFAULT_WRITE_LIMITS, now: () => number = Date.now): VersionStore {
  const entries = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const raw: RawStore = {
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
    // Počítadlo leží mezi hodnotami jako text, stejně jako v Redisu – `get` ho přečte.
    incr: (key) => {
      const next = Number(entries.get(key) ?? '0') + 1;
      entries.set(key, String(next));
      return Promise.resolve(next);
    },
    pushCapped: (key, value, cap) => {
      lists.set(key, [value, ...(lists.get(key) ?? [])].slice(0, cap));
      return Promise.resolve();
    },
    head: (key, count) => Promise.resolve((lists.get(key) ?? []).slice(0, count)),
    getMany: (keys) => Promise.resolve(keys.map((key) => entries.get(key) ?? null)),
  };
  return versionStoreOver('memory', 'memory', raw, limits, now);
}

export interface HttpVersionStoreConfig {
  /** Základ REST adresy úložiště. Bez koncového lomítka. */
  readonly url: string;
  readonly token: string;
  /** Táž předpona jako u knihy stropu. */
  readonly prefix: string;
  readonly timeoutMs: number;
  readonly limits?: WriteLimits;
  readonly now?: () => number;
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

  const raw: RawStore = {
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
    setNx: async (key, value, ttlSeconds) => (await command(['SET', key, value, 'NX', 'EX', String(ttlSeconds)])) === 'OK',
    async set(key, value, ttlSeconds) {
      await command(['SET', key, value, 'EX', String(ttlSeconds)]);
    },
    async incr(key, ttlSeconds) {
      const count = await command(['INCR', key]);
      if (typeof count !== 'number') throw new Error('version store answered a shape this server cannot read');
      // Expirace jen při prvním zvýšení – další ji neposouvají, den skončí kdy má.
      if (count === 1) await command(['EXPIRE', key, String(ttlSeconds)]);
      return count;
    },
    async pushCapped(key, value, cap, ttlSeconds) {
      await command(['LPUSH', key, value]);
      await command(['LTRIM', key, '0', String(cap - 1)]);
      await command(['EXPIRE', key, String(ttlSeconds)]);
    },
    async head(key, count) {
      const result = await command(['LRANGE', key, '0', String(count - 1)]);
      if (!Array.isArray(result) || !result.every((item) => typeof item === 'string')) throw new Error('version store answered a shape this server cannot read');
      return result as string[];
    },
    async getMany(keys) {
      const result = await command(['MGET', ...keys]);
      if (!Array.isArray(result) || result.length !== keys.length) throw new Error('version store answered a shape this server cannot read');
      return result.map((item) => (typeof item === 'string' ? item : null));
    },
  };
  return versionStoreOver('http', config.prefix, raw, config.limits ?? DEFAULT_WRITE_LIMITS, config.now ?? Date.now);
}

/** Kladné celé číslo z prostředí, jinak výchozí – špatná hodnota nesmí strop zrušit. */
function positiveInt(text: string | undefined, fallback: number): number {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function writeLimitsFromEnv(env: Record<string, string | undefined>): WriteLimits {
  return {
    ttlSeconds: positiveInt(env.PLAY_VERSION_TTL_SECONDS, DEFAULT_WRITE_LIMITS.ttlSeconds),
    dailyCap: positiveInt(env.PLAY_PUBLISH_DAILY_CAP, DEFAULT_WRITE_LIMITS.dailyCap),
  };
}

/** Jedno úložiště na proces, když se s nikým nesdílí. */
let processStore: VersionStore | null = null;

/** Jen pro testy. */
export function __resetProcessVersionStore(): void {
  processStore = null;
}

/**
 * Produkce bez sdíleného úložiště drží hry jen v paměti procesu – zmizí s ním.
 * Dveře to přiznají hlavičkou `x-play-store: memory`, odkaz nesmí předstírat trvalost.
 */
export function volatileVersionStore(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === 'production' && sharedStoreFromEnv(env) === null;
}

/** Sdílené úložiště podle prostředí (týž obchod a předpona jako kniha stropu), jinak paměť procesu. */
export function versionStoreFromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): VersionStore {
  const shared = sharedStoreFromEnv(env);
  const limits = writeLimitsFromEnv(env);
  if (shared !== null)
    return httpVersionStore({ url: shared.url, token: shared.token, prefix: storePrefix(env), timeoutMs: VERSION_STORE_TIMEOUT_MS, limits }, fetchImpl);
  if (processStore === null) {
    processStore = memoryVersionStore(limits);
    if (volatileVersionStore(env)) console.warn('[play] no shared store configured: published games live only in this process and vanish with it');
  }
  return processStore;
}
