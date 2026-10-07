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
 * - `<prefix>:play:recent` – seznam `RecentGame` od nejnovější, nejvýš `RECENT_CAP` (feed, P23-D T4),
 * - `<prefix>:play:dare:<dareId>` – JSON `DareRecord` (P36B T5), denní strop `<prefix>:play:dare-quota:<den>`;
 *   běh pro ducha (P37C T1) leží vedle v `<prefix>:play:ghost:<dareId>` s vlastní expirací a stropy
 *   `<prefix>:play:ghost-quota:<den>` a `<prefix>:play:ghost-quota:<den>:<hash volajícího>`;
 *   „duch nejlepšího“ hry (P37C T2) je schodiště v seřazené množině `<prefix>:play:best:<versionId>`
 *   (nejvýš `BEST_KEPT`) s časy zápisu v `<prefix>:play:best:<versionId>:at`,
 * - `<prefix>:play:loop:<finish|dare|skip|start|clear>:<versionId>` – čítače událostí smyčky pro řazení
 *   feedu (P36B T9) a „clear rate“ (P37C T5), hlas `<prefix>:play:loop-vote:<čítač>:<versionId>:<hash volajícího>` na den,
 * - `<prefix>:play:player:<id hráče>` – JSON `PlayerRecord` (P44B T3), nově vydané identity
 *   `<prefix>:play:new-player:<den>:<hash volajícího>`.
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

import { join } from 'node:path';

import { canonical } from '@/ir/worlddoc';
import type { LiveEntry } from '@/play/arcade/live';
import { LOOP_COUNTERS, type LoopCounter } from '@/play/loop-events';
import { sharedStoreFromEnv, storePrefix } from '@/server/spend-store';

import type { GameVersion } from '../contracts';
import { BUILTIN_IDS, withBuiltinGames } from './builtin';
import { feedEligible } from './feed';
import { emptyMemoryState, loadMemoryState, type MemoryState, reloadMemoryKey, saveMemoryKey, writableDir } from './file-store';
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
  /**
   * Zapíše jen, když klíč ještě není (`SET NX`); `false` = zabral ho někdo jiný.
   * Výpadek úložiště je `true` – nejhůř se zaplatí dvakrát, jako bez zámku.
   */
  claimUpgradeVerdict(draftId: string, value: string, ttlSeconds: number): Promise<boolean>;
  childrenOf(versionId: string): Promise<string[]>;
  /** Od kořene k listu, nejvýš `MAX_LINEAGE` nejnovějších záznamů. */
  lineageOf(versionId: string): Promise<GameVersion[]>;
  /**
   * Nejnovější autorské verze (`relation: 'upgrade'`, `publishEligible`), od
   * nejnovější, bez vypršelých; nedostupné úložiště je `[]`.
   */
  recent(limit: number): Promise<RecentGame[]>;
  /**
   * Seed feedu (P37C T6, jen `scripts/p37c/seed-feed.mjs`, žádné dveře): uloží
   * hru jako `put` a nově uloženou zařadí do feedu, i když není autorskou verzí –
   * větu napsal provozovatel a robot hru ověřil. `exists` řádek nepřidá podruhé.
   */
  feature(game: PublishedGame): Promise<PutOutcome>;
  /** Počet dětí každé verze, jedním čtením; nedostupné úložiště jsou nuly. */
  childCounts(versionIds: readonly string[]): Promise<number[]>;
  /**
   * Výzva ověřená přehráním (P36B T5), zapsaná jednou (`SET NX`); `quota` =
   * denní strop výzev vyčerpán, nic se nezapsalo. Výpadek je `VersionStoreUnavailable`.
   * Běh pro ducha (`dare.replay`, P37C T1) jde pod vlastní klíč a jen pod stropy
   * duchů, i k výzvě, která už je (`exists`) a ducha nemá. `voter` = hash
   * volajícího, kterému se běh počítá do stropu; bez něj se běh neuloží.
   */
  putDare(dare: DareRecord, voter?: string): Promise<'stored' | 'exists' | 'quota'>;
  /** `null` = neznámá, prošlá nebo nečitelná výzva, i při výpadku úložiště. */
  getDare(dareId: string): Promise<DareRecord | null>;
  /**
   * „Duch nejlepšího“ hry (P37C T2): výzva s uloženým během, nejvyšší skóre, při
   * shodě kratší čas. Píše ji `putDare`; `null` = žádná, i při výpadku úložiště.
   */
  bestDare(versionId: string): Promise<BestDare | null>;
  /**
   * Započte událost smyčky do jejích čítačů (P36B T9, P37C T5), jen hře, která
   * v úložišti je – jinak by kdokoli zakládal klíče na vymyšlená id – a nejvýš
   * jednou za `LOOP_VOTE_TTL_SECONDS` na `voter` (hash volajícího), čítač a hru:
   * falešné události z jedné adresy feed nepohnou (nález revize T9-1). Opakování
   * zná proces sám a nestojí ani příkaz úložiště. Výpadek spolkne: čítač je statistika.
   */
  countLoop(versionId: string, counters: readonly LoopCounter[], voter: string): Promise<void>;
  /** Čítače smyčky a počty remixů her jedním čtením; nedostupné úložiště = prázdná mapa (feed od nejnovější). */
  loopHeat(versionIds: readonly string[]): Promise<Map<string, LoopHeat>>;
  /** Hráč (P44B T3) podle id z podepsané cookie; `null` = bez uložené přezdívky, i při výpadku úložiště. */
  getPlayer(playerId: string): Promise<PlayerRecord | null>;
  /** Uloží hráče na dobu života hry. Výpadek je `VersionStoreUnavailable`. */
  putPlayer(playerId: string, player: PlayerRecord): Promise<void>;
  /**
   * Započte volajícímu (`voter`) jednu nově vydanou identitu na dnešek; `false` = byla by nad
   * `limit` (sybil, debata P44B T1). Výpadek úložiště je `VersionStoreUnavailable`.
   */
  countNewPlayer(voter: string, limit: number): Promise<boolean>;
}

/** Hráč žebříčku (P44B T3): jen přezdívka, kterou si sám zvolil. Id je klíč, do záznamu nejde. */
export interface PlayerRecord {
  readonly nickname: string;
}

/**
 * Výzva Dare (P36B T5): výsledek, který server sám spočítal přehráním vstupů
 * běhu – nikdy číslo od klienta. Anonymní, bez jména.
 */
export interface DareRecord {
  readonly dareId: string;
  readonly versionId: string;
  readonly score: number;
  readonly ticks: number;
  /** Hash konce přehrání (`hashArcade`). */
  readonly hash: string;
  /**
   * Kolik živých změn běh použil (0 = hra beze změny). Skóre pak patří změněné
   * hře – kamarád (T7) ho musí umět poznat (nález revize T5).
   */
  readonly liveChanges: number;
  readonly createdAt: string;
  /**
   * Běh pro přehrání ducha (P37C T1). Chybí u výzev zapsaných před ním, u běhu
   * nad `MAX_GHOST_BYTES`, nad stropy duchů a po `GHOST_TTL_SECONDS` – taková
   * výzva platí dál, jen ducha nemá.
   */
  readonly replay?: DareReplay;
}

/**
 * Běh výzvy (P37C T1): vstupy zhuštěné `packInputs` a živé změny, které běh
 * opravdu použil, v pořadí, v jakém je server přehrál. `v` je verze tvaru –
 * jiná, než tenhle kód zná, se čte jako výzva bez ducha.
 */
export interface DareReplay {
  readonly v: 1;
  readonly inputs: readonly number[];
  readonly patches: readonly LiveEntry[];
}

/**
 * Strop bajtů záznamu běhu pro ducha (P37C T1). Běh z klávesnice má pár kB;
 * analogové řízení, které mění osu každý tik, až ~60 kB – takový se neuloží
 * a výzva je bez ducha.
 */
export const MAX_GHOST_BYTES = 32 * 1024;

/**
 * Běh pro ducha žije 30 dní, ne jako hra (180): obchod se dělí s knihou stropu
 * a ta při plném obchodu selhává zavřeně. Nejhorší ustálený stav je denní strop
 * × strop bajtů × 30 dní = 150 × 32 kB × 30 ≈ 150 MB (nález revize T1-1 #2;
 * velikostní limit plánu Upstash repo nikde neuvádí). Výzva sama žije dál.
 */
export const GHOST_TTL_SECONDS = 30 * 24 * 3600;

/** Kolik běhů pro ducha se za den zapíše napříč volajícími; nad ním je výzva bez ducha. */
export const DEFAULT_GHOST_DAILY_CAP = 150;

/**
 * Kolik běhů pro ducha za den smí zapsat jeden volající (hash adresy): jedna
 * adresa jinak denní strop vyčerpá všem (nález revize T1-1 #1).
 */
export const GHOST_DAILY_CAP_PER_CALLER = 10;

/** Jeden volající započte hře každý čítač smyčky nejvýš jednou za den (P36B T9, nález revize T9-1). */
export const LOOP_VOTE_TTL_SECONDS = 24 * 3600;
/** Kolik hlasů si proces pamatuje, než paměť zahodí (pak rozhodne `SET NX` v úložišti). */
const MAX_VOTE_MEMO = 20_000;
/**
 * Hlasy, které proces už započetl, s koncem platnosti (ms) – na úrovni modulu,
 * protože s Upstash vzniká úložiště při každém `store()` znovu (nález revize T9-2).
 * Klíč nese druh a předponu úložiště; testy ji mažou s úložištěm procesu.
 */
const voted = new Map<string, number>();

/** Co hráči s hrou udělali (P36B T9): čítače událostí smyčky a počet remixů (dětí verze). */
export interface LoopHeat {
  readonly finishes: number;
  readonly dares: number;
  readonly skips: number;
  /** Pokusy a výhry pro „clear rate“ (P37C T5); feed podle nich neřadí. */
  readonly starts: number;
  readonly clears: number;
  /** Opakování, sdílení a okamžité odchody (P40 T4), každé jeden hlas volajícího za den. */
  readonly retries: number;
  readonly shares: number;
  readonly bounces: number;
  readonly remixes: number;
}

/** Řádek feedu: verze plus to, co karta ukáže a co feed potřebuje k rozmanitosti. */
export interface RecentGame extends GameVersion {
  readonly archetype: string;
  /** Chybí jen u hry ze seedu feedu a z vestavěné sady (P37C T6), ta má místo toho `curated`. */
  readonly relation?: 'upgrade';
  /** Věta provozovatele, hra ověřená robotem (P37C T6, `feature` a vestavěná sada). */
  readonly curated?: true;
  /** `spec.tutorial.goalLine` a `spec.theme.mood` pro kartu; řádky zapsané před D-R1 je nemají. */
  readonly goal?: string;
  readonly mood?: string;
}

/** Kolik publikací si feed pamatuje. */
export const RECENT_CAP = 200;

/** Řádek feedu z hry: verze, archetyp, cíl a nálada pro kartu. */
export function feedRowOf(game: PublishedGame): RecentGame {
  return {
    ...game.version,
    archetype: game.spec.archetype,
    ...(game.relation === undefined ? {} : { relation: game.relation }),
    goal: game.spec.tutorial.goalLine,
    mood: game.spec.theme.mood,
  };
}

export type PutOutcome = 'stored' | 'exists' | 'conflict' | 'quota';

export const MAX_LINEAGE = 32;

/** Meze zápisu; `versionStoreFromEnv` je čte z `PLAY_VERSION_TTL_SECONDS` a `PLAY_PUBLISH_DAILY_CAP`. */
export interface WriteLimits {
  /**
   * Jak dlouho hra žije od publikace. Výchozí 180 dní: porota otvírá odkazy týdny
   * po odevzdání a se 60 dny by hra vytvořená 24. 9. 2026 zmizela 23. 11., dva dny
   * před vyhlášením 25. 11. Rezerva pokryje i hry publikované po odevzdání.
   * `EX` se píše jen při publikaci: hrám uloženým dřív prodlouží expiraci
   * jednorázově `scripts/play-extend-ttl.mjs`.
   */
  readonly ttlSeconds: number;
  /** Kolik publikací (pokusů o zápis) za den napříč všemi volajícími; autorská dítě (`relation: 'upgrade'`) se nepočítají. */
  readonly dailyCap: number;
  /**
   * Kolik výzev Dare (pokusů o zápis) za den napříč všemi volajícími (P36B T5);
   * chybí = `DEFAULT_DARE_DAILY_CAP`. Táž třída meze jako `dailyCap`: anonymní
   * zápisy do obchodu, o který se dělí kniha stropu.
   */
  readonly dareDailyCap?: number;
  /** Kolik výzev s během pro ducha za den (P37C T1); chybí = `DEFAULT_GHOST_DAILY_CAP`. */
  readonly ghostDailyCap?: number;
}

/** Výzva je ~200 B; 2 000 denně je pod 0,5 MB za den i při plné expiraci. */
export const DEFAULT_DARE_DAILY_CAP = 2_000;

export const DEFAULT_WRITE_LIMITS: WriteLimits = { ttlSeconds: 180 * 24 * 3600, dailyCap: 500, dareDailyCap: DEFAULT_DARE_DAILY_CAP, ghostDailyCap: DEFAULT_GHOST_DAILY_CAP };

/** Tvar id výzvy: 32 hex znaků. */
export const DARE_ID_PATTERN = /^[a-f0-9]{32}$/;

function isDare(value: unknown): value is DareRecord {
  if (typeof value !== 'object' || value === null) return false;
  const { dareId, versionId, score, ticks, hash, liveChanges, createdAt } = value as Record<string, unknown>;
  return (
    typeof dareId === 'string' &&
    typeof versionId === 'string' &&
    Number.isInteger(score) &&
    Number.isInteger(ticks) &&
    typeof hash === 'string' &&
    Number.isInteger(liveChanges) &&
    typeof createdAt === 'string'
  );
}

/** Běh výzvy, jak ho zná tenhle kód; jiná verze nebo rozbitý tvar = `undefined` (výzva bez ducha). */
function replayOf(value: unknown): DareReplay | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { v, inputs, patches } = value as Record<string, unknown>;
  return v === 1 && Array.isArray(inputs) && Array.isArray(patches) ? { v, inputs: inputs as number[], patches: patches as LiveEntry[] } : undefined;
}

/** JSON z úložiště; chybějící nebo rozbitý záznam je `null`. */
function parsedOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Výzva bez běhu – tak se zapisuje; běh leží pod vlastním klíčem. */
function withoutReplay(dare: DareRecord): DareRecord {
  const { dareId, versionId, score, ticks, hash, liveChanges, createdAt } = dare;
  return { dareId, versionId, score, ticks, hash, liveChanges, createdAt };
}

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
  exists(key: string): Promise<boolean>;
  /**
   * „Schodiště“ nejlepších (P37C T2, rozhodnutí k nálezu revize T2-2), jedním
   * atomickým krokem: přidá člena s hodnocením `rank` a časem zápisu `at` (ms),
   * vyhodí každého člena hodnoceného níž nebo stejně – nový běh vyprší poslední,
   * horší ani shodný starší už nebude potřeba nikdy (rozhodnutí k revizi T2-3) –
   * a každého zapsaného nejpozději v `staleBefore` (jeho běh vypršel). Zbylé
   * hodnocení klesá a čas zápisu roste, nový člen je nejníž. Nad `keep` členů
   * odejdou ti těsně nad novým: nejlepší i nový zůstanou, hra ukazuje nejlepší
   * a bez ducha nezůstane, dokud nějaký běh leží.
   */
  keepBest(key: string, member: string, rank: number, at: number, staleBefore: number, keep: number, ttlSeconds: number): Promise<void>;
  /** Nejvýš `count` nejvýš hodnocených členů seřazené množiny, od nejvyššího. */
  top(key: string, count: number): Promise<{ readonly member: string; readonly rank: number }[]>;
  /** Zbývající život klíče v ms; chybějící klíč nebo klíč bez expirace ≤ 0. */
  msLeft(key: string): Promise<number>;
  /** Celé schodiště nejlepších s časem zápisu každého člena (chybí-li, 0). */
  staircase(key: string): Promise<{ readonly member: string; readonly rank: number; readonly at: number }[]>;
  /** Jedním atomickým krokem odebere `drop` z obou množin schodiště a přidá člena s hodnocením `rank` a časem zápisu `at`. */
  reviseBest(key: string, drop: readonly string[], member: string, rank: number, at: number, ttlSeconds: number): Promise<void>;
}

/** Ve kterém řádu hodnocení nejlepší výzvy leží skóre; tiky (≤ 5 400) se vejdou pod něj. */
const BEST_TICK_SPAN = 8192;

/**
 * Strop schodiště nejlepších výzev hry. Schodiště drží jen běhy z posledních 30
 * dní, z nichž každý je horší než všechny před ním – při náhodném pořadí výsledků
 * jich je v průměru ln(počet běhů) + 0,58, přes 8 až kolem 1 700 běhů jedné hry
 * za měsíc. Nad stropem odejde člen těsně nad novým během: nejlepší zůstane
 * a po expiraci starších přijde řada na nový. Čtení vezme
 * nejvyšší, jehož běh ještě leží (nález revize T2-1), nejvýš 8 dotazů.
 */
export const BEST_KEPT = 8;

/**
 * Hodnocení výzvy pro „ducha nejlepšího“ (P37C T2): vyšší skóre, při shodě
 * kratší čas. Skóre je Int32 – součin zůstane pod 2^53, číslo je přesné.
 */
export function bestRank(score: number, ticks: number): number {
  return score * BEST_TICK_SPAN + (BEST_TICK_SPAN - 1 - ticks);
}

/** Nejlepší ověřená výzva hry s duchem (P37C T2). */
export interface BestDare {
  readonly dareId: string;
  readonly score: number;
  readonly ticks: number;
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
  const dareKey = (dareId: string): string => `${prefix}:play:dare:${dareId}`;
  const dareQuotaKey = (): string => `${prefix}:play:dare-quota:${quotaDay(now())}`;
  const ghostKey = (dareId: string): string => `${prefix}:play:ghost:${dareId}`;
  const ghostQuotaKey = (voter?: string): string => `${prefix}:play:ghost-quota:${quotaDay(now())}${voter === undefined ? '' : `:${voter}`}`;
  const bestKey = (versionId: string): string => `${prefix}:play:best:${versionId}`;
  const ghostTtlSeconds = Math.min(limits.ttlSeconds, GHOST_TTL_SECONDS);
  /**
   * Běh pro ducha pod stropem bajtů, stropem volajícího a denním stropem; jinak nic – výzva platí i bez něj.
   * `written` = běh se právě zapsal; `present` = ležel už dřív a jeho expirace běží od dřívějška.
   */
  const keepGhost = async (dareId: string, replay: DareReplay, voter: string): Promise<'written' | 'present' | 'refused'> => {
    if (await raw.exists(ghostKey(dareId))) return 'present';
    const text = JSON.stringify(replay);
    if (new TextEncoder().encode(text).length > MAX_GHOST_BYTES) return 'refused';
    // Volajícího soudit první: vyčerpaný volající pak denní strop neubírá ostatním.
    if ((await raw.incr(ghostQuotaKey(voter), 2 * 24 * 3600)) > GHOST_DAILY_CAP_PER_CALLER) return 'refused';
    if ((await raw.incr(ghostQuotaKey(), 2 * 24 * 3600)) > (limits.ghostDailyCap ?? DEFAULT_GHOST_DAILY_CAP)) return 'refused';
    return (await raw.setNx(ghostKey(dareId), text, ghostTtlSeconds)) ? 'written' : 'present';
  };
  /**
   * Doplní do schodiště běh, jehož duch leží, ale zápis schodiště selhal (nález revize T2-3 #3, R3).
   * Čas zápisu se bere z expirace ducha, ne z teď: běh vyhodí jen horší nebo stejné členy, kteří
   * vyprší dřív než on, a lepšímu nebo stejnému, který žije déle, ustoupí. Nad stropem odejde soused
   * běhu – nejlepší ani nejnovější ne, jako u `keepBest`.
   */
  const healBest = async (dare: DareRecord): Promise<void> => {
    const key = bestKey(dare.versionId);
    const steps = await raw.staircase(key);
    if (steps.some(({ member }) => member === dare.dareId)) return;
    const left = await raw.msLeft(ghostKey(dare.dareId));
    if (left <= 0) return;
    const rank = bestRank(dare.score, dare.ticks);
    const at = now() - (ghostTtlSeconds * 1000 - left);
    if (steps.some((step) => step.rank >= rank && step.at >= at)) return;
    const stale = now() - ghostTtlSeconds * 1000;
    const drop = steps.filter((step) => step.at <= stale || (step.rank <= rank && step.at <= at));
    const kept = [...steps.filter((step) => !drop.includes(step)), { member: dare.dareId, rank, at }].sort((a, b) => b.rank - a.rank);
    const self = kept.findIndex(({ member }) => member === dare.dareId);
    const neighbour = kept.length > BEST_KEPT ? kept[self >= 2 ? self - 1 : self + 1] : undefined;
    await raw.reviseBest(key, [...drop, ...(neighbour === undefined ? [] : [neighbour])].map(({ member }) => member), dare.dareId, rank, at, ghostTtlSeconds);
  };
  const loopKey = (counter: LoopCounter, versionId: string): string => `${prefix}:play:loop:${counter}:${versionId}`;
  const voteKey = (vote: string): string => `${prefix}:play:loop-vote:${vote}`;
  const playerKey = (playerId: string): string => `${prefix}:play:player:${playerId}`;

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
        // hry a strop by pustil jen polovinu vět. Vestavěná hra (P37C T6) není publikace
        // návštěvníka: obal ji ukládá při první události, a ta by ubrala z jejich stropu.
        if (game.relation !== 'upgrade' && !BUILTIN_IDS.has(game.version.versionId) && (await raw.incr(quotaKey(), 2 * 24 * 3600)) > limits.dailyCap) return 'quota';
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
        try {
          await raw.pushCapped(recentKey, JSON.stringify(feedRowOf(game)), RECENT_CAP, limits.ttlSeconds);
        } catch {
          // Feed je navigace: hra je uložená a odkaz na ni platí, i když se do feedu nedostala.
        }
      }
      return 'stored';
    },
    async feature(game) {
      const outcome = await store.put(game);
      // Nově uloženou autorskou verzi do feedu zařadil už `put`. Hra, která v úložišti byla, řádek dostane,
      // jen když ho nemá: zápis řádku mohl minule selhat až po uložení hry (nález revize T6-2 #3).
      if ((outcome === 'stored' && game.relation === 'upgrade') || (outcome !== 'stored' && outcome !== 'exists')) return outcome;
      try {
        if (outcome === 'exists' && (await raw.head(recentKey, RECENT_CAP)).some((text) => (parsedOrNull(text) as { versionId?: unknown } | null)?.versionId === game.version.versionId))
          return outcome;
        await raw.pushCapped(recentKey, JSON.stringify({ ...feedRowOf(game), curated: true }), RECENT_CAP, limits.ttlSeconds);
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
      return outcome;
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
    async claimUpgradeVerdict(draftId, value, ttlSeconds) {
      try {
        return await raw.setNx(verdictKey(draftId), value, ttlSeconds);
      } catch {
        return true;
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
    async putDare(dare, voter) {
      let outcome: 'stored' | 'exists';
      try {
        // Týž běh podruhé denní strop neubírá: jinak jeden opakovaný požadavek zavře výzvy všem (nález revize T5).
        if ((await raw.get(dareKey(dare.dareId))) !== null) outcome = 'exists';
        else if ((await raw.incr(dareQuotaKey(), 2 * 24 * 3600)) > (limits.dareDailyCap ?? DEFAULT_DARE_DAILY_CAP)) return 'quota';
        else outcome = (await raw.setNx(dareKey(dare.dareId), JSON.stringify(withoutReplay(dare)), limits.ttlSeconds)) ? 'stored' : 'exists';
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
      // Běh pro ducha i k výzvě, která už je: výzva zapsaná nad stropem duchů ho dostane
      // opakovaným odesláním jindy (nález revize T1-1 #1). Duch je navíc – výpadek výzvu neshodí.
      if (dare.replay === undefined || voter === undefined) return outcome;
      try {
        // Do schodiště nejlepších (P37C T2) běh zapsaný právě teď s časem teď: ten pak říká,
        // kdy běh vyprší. Znovu poslaný starší běh jde přes `healBest` s časem svého zápisu –
        // s časem teď by vyhodil horší, ale déle žijící členy.
        // Množina žije 30 dní od posledního zápisu, jako běh nejnovějšího člena.
        const ghost = await keepGhost(dare.dareId, dare.replay, voter);
        if (ghost === 'written') {
          const at = now();
          await raw.keepBest(bestKey(dare.versionId), dare.dareId, bestRank(dare.score, dare.ticks), at, at - ghostTtlSeconds * 1000, BEST_KEPT, ghostTtlSeconds);
        } else if (ghost === 'present') await healBest(dare);
      } catch {
        // Duch je navíc – výpadek výzvu neshodí.
      }
      return outcome;
    },
    async bestDare(versionId) {
      try {
        // Od nejvyššího první, jehož běh ještě leží: obvykle hned první, tedy jeden příkaz navíc.
        for (const { member, rank } of await raw.top(bestKey(versionId), BEST_KEPT)) {
          if (!DARE_ID_PATTERN.test(member) || !Number.isSafeInteger(rank) || !(await raw.exists(ghostKey(member)))) continue;
          const score = Math.floor(rank / BEST_TICK_SPAN);
          return { dareId: member, score, ticks: BEST_TICK_SPAN - 1 - (rank - score * BEST_TICK_SPAN) };
        }
      } catch {
        // Nedostupné úložiště = žádný duch nejlepšího.
      }
      return null;
    },
    async getDare(dareId) {
      let texts: (string | null)[];
      try {
        texts = await raw.getMany([dareKey(dareId), ghostKey(dareId)]);
      } catch {
        return null;
      }
      const [text, ghost] = texts;
      const parsed = parsedOrNull(text ?? null);
      if (!isDare(parsed)) return null;
      const replay = replayOf(parsedOrNull(ghost ?? null));
      return replay === undefined ? withoutReplay(parsed) : { ...withoutReplay(parsed), replay };
    },
    async countLoop(versionId, counters, voter) {
      const fresh = counters.filter((counter) => {
        const seen = `${id}:${prefix}:${counter}:${versionId}:${voter}`;
        if ((voted.get(seen) ?? 0) > now()) return false;
        if (voted.size >= MAX_VOTE_MEMO) voted.clear();
        voted.set(seen, now() + LOOP_VOTE_TTL_SECONDS * 1000);
        return true;
      });
      if (fresh.length === 0) return;
      try {
        // Existenci hry stačí ověřit jednou za událost, ne za každý čítač (nález revize T5-1 #3).
        if (!(await raw.exists(versionKey(versionId)))) return;
        for (const counter of fresh) {
          // Hlas v úložišti platí napříč instancemi; teprve nový hlas zvýší čítač.
          if (!(await raw.setNx(voteKey(`${counter}:${versionId}:${voter}`), '1', LOOP_VOTE_TTL_SECONDS))) continue;
          // Čítač žije nejvýš tak dlouho jako hra (expirace od prvního zvýšení).
          await raw.incr(loopKey(counter, versionId), limits.ttlSeconds);
        }
      } catch {
        // Nezapočtená událost jen trochu posune feed.
      }
    },
    async loopHeat(versionIds) {
      if (versionIds.length === 0) return new Map();
      const per = LOOP_COUNTERS.length + 1;
      try {
        const texts = await raw.getMany(versionIds.flatMap((versionId) => [...LOOP_COUNTERS.map((counter) => loopKey(counter, versionId)), childrenKey(versionId)]));
        const count = (text: string | null | undefined): number => {
          const value = Number(text ?? '0');
          return Number.isSafeInteger(value) && value > 0 ? value : 0;
        };
        const remixes = (text: string | null | undefined): number => {
          try {
            return text === null || text === undefined ? 0 : (JSON.parse(text) as string[]).length;
          } catch {
            return 0;
          }
        };
        return new Map(
          versionIds.map((versionId, index) => {
            // Pořadí je `LOOP_COUNTERS`, za nimi děti verze.
            const [finishes, dares, skips, starts, clears, retries, shares, bounces, children] = texts.slice(index * per, index * per + per);
            return [
              versionId,
              {
                finishes: count(finishes),
                dares: count(dares),
                skips: count(skips),
                starts: count(starts),
                clears: count(clears),
                retries: count(retries),
                shares: count(shares),
                bounces: count(bounces),
                remixes: remixes(children),
              },
            ];
          }),
        );
      } catch {
        return new Map();
      }
    },
    async getPlayer(playerId) {
      let parsed: unknown;
      try {
        parsed = parsedOrNull(await raw.get(playerKey(playerId)));
      } catch {
        return null;
      }
      const nickname = (parsed as { nickname?: unknown } | null)?.nickname;
      return typeof nickname === 'string' ? { nickname } : null;
    },
    async putPlayer(playerId, player) {
      try {
        await raw.set(playerKey(playerId), JSON.stringify({ nickname: player.nickname }), limits.ttlSeconds);
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
    },
    async countNewPlayer(voter, limit) {
      try {
        return (await raw.incr(`${prefix}:play:new-player:${quotaDay(now())}:${voter}`, 2 * 24 * 3600)) <= limit;
      } catch (thrown) {
        throw new VersionStoreUnavailable(thrown);
      }
    },
  };
  return store;
}

/**
 * Hodnoty (`set`/`setNx`) vyprší po svém TTL jako v Redisu – krátké záznamy
 * remixů by jinak rostly do restartu (P27C T4d). Počítadla vyprší od prvního
 * zvýšení (P40 T3b). Seznamy neexpirují, drží je strop délky.
 */
export function memoryVersionStore(limits: WriteLimits = DEFAULT_WRITE_LIMITS, now: () => number = Date.now): VersionStore {
  return versionStoreOver('memory', 'memory', memoryRaw(emptyMemoryState(), now), limits, now);
}

/**
 * Hry, remixy a čítače na disku (P40 T3), jinak totéž co `memoryVersionStore`:
 * stav se načte z `dir` a každý změněný klíč se hned zapíše (`file-store.ts`).
 * Přežije restart serveru. Každý klíč se před použitím dočte z disku, takže
 * instance nad týmž adresářem si zápisy nepřepíšou (P40 T3c); zámek mezi nimi
 * ale není – dva zápisy v téže chvíli umí jen Upstash.
 */
export function fileVersionStore(dir: string, limits: WriteLimits = DEFAULT_WRITE_LIMITS, now: () => number = Date.now): VersionStore {
  const state = loadMemoryState(dir, now);
  const raw = memoryRaw(
    state,
    now,
    (key) => saveMemoryKey(dir, state, key),
    (key) => reloadMemoryKey(dir, state, key),
  );
  return versionStoreOver('file', 'file', raw, limits, now);
}

function restore<T>(map: Map<string, T>, key: string, value: T | undefined): void {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}

/**
 * Příkazy úložiště nad stavem v paměti; `changed` dostane každý klíč, který se změnil nebo vypršel,
 * `reload` každý klíč před čtením a před „přečti, přidej, zapiš“.
 */
function memoryRaw(
  state: MemoryState,
  now: () => number,
  changed: (key: string) => void = () => undefined,
  reload: (key: string) => void = () => undefined,
): RawStore {
  const { entries, expiresAt, lists, sets } = state;
  const live = (key: string): string | null => {
    reload(key);
    const until = expiresAt.get(key);
    if (until !== undefined && now() >= until) {
      entries.delete(key);
      expiresAt.delete(key);
      changed(key);
    }
    return entries.get(key) ?? null;
  };
  /**
   * Změna klíče platí, jen když ji `changed` zapíše (P40 T3a): selhaný zápis na disk
   * vrátí klíč v paměti, jak byl, a chybu pustí dál. Jinak by hra po 503 zůstala
   * jen v paměti a další `put` by ji ohlásil jako uloženou, než ji restart smaže.
   */
  const commit = (key: string, apply: () => void): void => {
    const before = { value: entries.get(key), until: expiresAt.get(key), list: lists.get(key), set: sets.get(key) };
    apply();
    try {
      changed(key);
    } catch (thrown) {
      restore(entries, key, before.value);
      restore(expiresAt, key, before.until);
      restore(lists, key, before.list);
      restore(sets, key, before.set);
      throw thrown;
    }
  };
  const write = (key: string, value: string, ttlSeconds: number): void => {
    commit(key, () => {
      entries.set(key, value);
      expiresAt.set(key, now() + ttlSeconds * 1000);
    });
  };
  /** Schodiště nejlepších (člen → hodnocení a čas zápisu) s expirací jako hodnoty. */
  const liveSet = (key: string): Map<string, { readonly rank: number; readonly at: number }> | undefined => {
    reload(key);
    const until = expiresAt.get(key);
    if (until !== undefined && now() >= until) {
      sets.delete(key);
      expiresAt.delete(key);
      changed(key);
    }
    return sets.get(key);
  };
  return {
    get: (key) => Promise.resolve(live(key)),
    setNx: (key, value, ttlSeconds) => {
      if (live(key) !== null) return Promise.resolve(false);
      write(key, value, ttlSeconds);
      return Promise.resolve(true);
    },
    set: (key, value, ttlSeconds) => {
      write(key, value, ttlSeconds);
      return Promise.resolve();
    },
    // Počítadlo leží mezi hodnotami jako text, stejně jako v Redisu – `get` ho přečte.
    // Expirace při prvním zvýšení jako `INCR` + `EXPIRE` v `httpVersionStore` (P40 T3b): denní
    // čítače by jinak na disku přibývaly a četly se při každém startu. Bez expirace = soubor z doby
    // před T3b, dostane ji teď.
    incr: (key, ttlSeconds) => {
      const next = Number(live(key) ?? '0') + 1;
      commit(key, () => {
        entries.set(key, String(next));
        if (!expiresAt.has(key)) expiresAt.set(key, now() + ttlSeconds * 1000);
      });
      return Promise.resolve(next);
    },
    pushCapped: (key, value, cap) => {
      reload(key);
      commit(key, () => lists.set(key, [value, ...(lists.get(key) ?? [])].slice(0, cap)));
      return Promise.resolve();
    },
    head: (key, count) => {
      reload(key);
      return Promise.resolve((lists.get(key) ?? []).slice(0, count));
    },
    getMany: (keys) => Promise.resolve(keys.map(live)),
    exists: (key) => Promise.resolve(live(key) !== null),
    keepBest: (key, member, rank, at, staleBefore, keep, ttlSeconds) => {
      const kept = [...(liveSet(key) ?? [])].filter(([other, entry]) => other !== member && entry.rank > rank && entry.at > staleBefore);
      kept.push([member, { rank, at }]);
      // Pořadí Redisu: hodnocení, při shodě člen podle bajtů; vrchol je poslední. Nový běh leží na indexu 0,
      // nad `keep` odejdou členové těsně nad ním – jako `ZREMRANGEBYRANK key 1 -keep`.
      kept.sort(([am, a], [bm, b]) => a.rank - b.rank || (am < bm ? -1 : am > bm ? 1 : 0));
      commit(key, () => {
        sets.set(key, new Map(kept.filter((_, index) => index === 0 || index > kept.length - keep)));
        expiresAt.set(key, now() + ttlSeconds * 1000);
      });
      return Promise.resolve();
    },
    top: (key, count) => {
      return Promise.resolve([...(liveSet(key) ?? [])].slice(-count).reverse().map(([member, { rank }]) => ({ member, rank })));
    },
    msLeft: (key) => Promise.resolve(live(key) === null ? -2 : (expiresAt.get(key) ?? now()) - now()),
    staircase: (key) => Promise.resolve([...(liveSet(key) ?? [])].map(([member, { rank, at }]) => ({ member, rank, at }))),
    reviseBest: (key, drop, member, rank, at, ttlSeconds) => {
      const kept = [...(liveSet(key) ?? [])].filter(([other]) => !drop.includes(other) && other !== member);
      kept.push([member, { rank, at }]);
      kept.sort(([am, a], [bm, b]) => a.rank - b.rank || (am < bm ? -1 : am > bm ? 1 : 0));
      commit(key, () => {
        sets.set(key, new Map(kept));
        expiresAt.set(key, now() + ttlSeconds * 1000);
      });
      return Promise.resolve();
    },
  };
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

  /**
   * Příkazy jedním požadavkem transakce (`/multi-exec`): úložiště je provede
   * všechny bez proložení cizími, nebo žádný. Chyba jednoho další nezastaví
   * (dokumentace Upstash REST, „Transactions“) – proto končí `EXPIRE`.
   */
  const transaction = async (commands: readonly (readonly string[])[]): Promise<void> => {
    const response = await fetchImpl(`${config.url}/multi-exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new Error(`version store answered ${String(response.status)}`);
    const results = (await response.json()) as unknown;
    if (!Array.isArray(results) || results.length !== commands.length || results.some((item) => typeof item !== 'object' || item === null || 'error' in item))
      throw new Error('version store refused part of a transaction');
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
    exists: async (key) => (await command(['EXISTS', key])) === 1,
    async keepBest(key, member, rank, at, staleBefore, keep, ttlSeconds) {
      // Čas zápisu leží ve druhé množině; průnik s váhou 0 nechá v každé jen členy obou a její vlastní skóre.
      const written = `${key}:at`;
      await transaction([
        ['ZREMRANGEBYSCORE', key, '-inf', String(rank)],
        ['ZADD', key, String(rank), member],
        ['ZADD', written, String(at), member],
        ['ZREMRANGEBYSCORE', written, '-inf', String(staleBefore)],
        ['ZINTERSTORE', key, '2', key, written, 'WEIGHTS', '1', '0'],
        ['ZREMRANGEBYRANK', key, '1', String(-keep)],
        ['ZINTERSTORE', written, '2', written, key, 'WEIGHTS', '1', '0'],
        ['EXPIRE', key, String(ttlSeconds)],
        ['EXPIRE', written, String(ttlSeconds)],
      ]);
    },
    async top(key, count) {
      return (await scored(key, -count)).reverse().map(([member, rank]) => ({ member, rank }));
    },
    async msLeft(key) {
      const left = await command(['PTTL', key]);
      if (typeof left !== 'number') throw new Error('version store answered a shape this server cannot read');
      return left;
    },
    async staircase(key) {
      const [ranks, times] = await Promise.all([scored(key, 0), scored(`${key}:at`, 0)]);
      const written = new Map(times);
      return ranks.map(([member, rank]) => ({ member, rank, at: written.get(member) ?? 0 }));
    },
    async reviseBest(key, drop, member, rank, at, ttlSeconds) {
      const written = `${key}:at`;
      await transaction([
        ...(drop.length === 0 ? [] : [['ZREM', key, ...drop], ['ZREM', written, ...drop]]),
        ['ZADD', key, String(rank), member],
        ['ZADD', written, String(at), member],
        ['EXPIRE', key, String(ttlSeconds)],
        ['EXPIRE', written, String(ttlSeconds)],
      ]);
    },
  };
  /** Členové seřazené množiny od indexu `from` do konce, od nejníž hodnoceného, se skóre. */
  async function scored(key: string, from: number): Promise<[string, number][]> {
    const result = await command(['ZRANGE', key, String(from), '-1', 'WITHSCORES']);
    if (!Array.isArray(result) || result.length % 2 !== 0 || !result.every((item) => typeof item === 'string'))
      throw new Error('version store answered a shape this server cannot read');
    const pairs: [string, number][] = [];
    for (let i = 0; i < result.length; i += 2) pairs.push([result[i] as string, Number(result[i + 1])]);
    return pairs;
  }
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
    dareDailyCap: positiveInt(env.PLAY_DARE_DAILY_CAP, DEFAULT_DARE_DAILY_CAP),
    ghostDailyCap: positiveInt(env.PLAY_GHOST_DAILY_CAP, DEFAULT_GHOST_DAILY_CAP),
  };
}

/** Jedno úložiště na proces, když se s nikým nesdílí. */
let processStore: VersionStore | null = null;

/** Jen pro testy. */
export function __resetProcessVersionStore(): void {
  processStore = null;
  voted.clear();
}

/**
 * Produkce bez sdíleného úložiště drží hry jen v paměti procesu – zmizí s ním.
 * Dveře to přiznají hlavičkou `x-play-store: memory`, odkaz nesmí předstírat trvalost.
 */
export function volatileVersionStore(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === 'production' && sharedStoreFromEnv(env) === null && versionStoreFromEnv(env).id !== 'file';
}

/**
 * Adresář souborového úložiště (P40 T3): `PLAY_STORE_DIR`, jinak `data/play/store`.
 * `null` na Vercelu (souborový systém jen pro čtení, produkce jde přes Upstash)
 * a pod vitestem bez `PLAY_STORE_DIR` – testy by si jinak přes restart nesly hry
 * z disku. Podle `NODE_ENV` se nevolí: lokální `next start` je taky produkce.
 */
export function fileStoreDirFromEnv(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL !== undefined) return null;
  if (env.PLAY_STORE_DIR !== undefined) return env.PLAY_STORE_DIR;
  return env.VITEST !== undefined ? null : join(process.cwd(), 'data', 'play', 'store');
}

/**
 * Sdílené úložiště podle prostředí (týž obchod a předpona jako kniha stropu), jinak soubory
 * v zapisovatelném `fileStoreDirFromEnv`, jinak paměť procesu. Vše s vestavěnou sadou her
 * (P37C T6): feed ani odkaz na ni nezůstanou prázdné.
 */
export function versionStoreFromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): VersionStore {
  const shared = sharedStoreFromEnv(env);
  const limits = writeLimitsFromEnv(env);
  if (shared !== null)
    return withBuiltinGames(httpVersionStore({ url: shared.url, token: shared.token, prefix: storePrefix(env), timeoutMs: VERSION_STORE_TIMEOUT_MS, limits }, fetchImpl));
  if (processStore === null) {
    const dir = fileStoreDirFromEnv(env);
    const onDisk = dir !== null && writableDir(dir);
    processStore = withBuiltinGames(onDisk ? fileVersionStore(dir, limits) : memoryVersionStore(limits));
    if (!onDisk && env.NODE_ENV === 'production') console.warn('[play] no shared store configured: published games live only in this process and vanish with it');
  }
  return processStore;
}
