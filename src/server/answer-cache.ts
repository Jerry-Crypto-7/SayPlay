/**
 * **Odpověď modelu na doslova stejnou větu se vydá znovu, ne koupí podruhé**
 * (P16 T6).
 *
 * Porotce na demo dni napíše tutéž větu, jakou před ním napsal kolega, nebo
 * vlastní větu podruhé po obnovení stránky. Plánovač i kompilátor odpovídají
 * na tutéž otázku tímtéž — a každá taková dvojice stojí dvě placená volání
 * a přes minutu čekání. Tenhle modul si dvojici pamatuje sedm dní pod klíčem,
 * který je celá otázka: normalizovaná věta, verze promptu, model, **úsilí
 * každé fáze tak, jak se doopravdy pošle** (`effortForCall` v `upstream.ts`,
 * ne holé `WORLDSMITH_MODEL_EFFORT` — plánovač jede na `STAGE_EFFORT`), a
 * koncový bod. Bez posledních dvou by změna tabulky úsilí nebo přepnutí
 * poskytovatele pod týmž jménem modelu vydávalo sedm dní staré odpovědi
 * (nález revize nad `7a3808f`).
 *
 * ## Kde to sedí vůči stropu utrácení a vypínačům
 *
 * **Za všemi branami, nikdy před nimi.** Route pustí požadavek přes kill
 * switch, strop frekvence, moderaci a výběr zdroje beze změny; cache se ptá
 * až `runGeneration` (`src/worldstream/sessions.ts`), tedy ve chvíli, kdy by
 * jinak odešlo první volání. Zásah to volání **neudělá**, takže se nic
 * nerezervuje — a odmítnutí stropem cache nikdy neobchází, protože odmítnutý
 * strop znamená, že se nevolalo, a co se nevolalo, to se nikdy neuložilo.
 * Ukládá se jedině dvojice, která prošla oběma branami (plánovač přijatý,
 * blueprint zkompilovaný); odmítnutí, výpadek ani půlka světa do cache nejde.
 *
 * ## Co se ukládá: co model NAPSAL, ne co z toho vzniklo
 *
 * Hodnota jsou syrové odpovědi obou fází **a věta, nad kterou vznikly**.
 * Blueprint se z nich při zásahu **staví znovu** týmž kompilátorem a týmiž
 * branami jako poprvé: nese `sessionSeed` nové relace a projde validací
 * dnešního buildu. Kdyby se ukládal hotový blueprint, vydal by se svět
 * z včerejšího schématu pod dnešním klientem. A protože prompt se mění
 * častěji než validace, ale ne vždycky s ní, je i uložená odpověď, která
 * branou už neprojde, prostě **miss** — relace jede živě a záznam se přepíše.
 *
 * **Plán se soudí proti uložené větě, ne proti té nové.** Klíč větu
 * normalizuje (velikost písmen, mezery), ale `readSceneSpec` odmítá
 * `requested` citaci, která není doslovný substring věty — proti nové větě
 * by tedy `A Table` / `a table` byl zásah v klíči a miss v replayi, tedy
 * dvě zaplacená volání s cache, která tvrdí, že šetří. Model odpovídal na
 * uloženou větu, a proti ní jeho citace platí; svět se pak stejně lowersuje
 * nad novým seedem.
 *
 * ## Úložiště je totéž co kniha stropu
 *
 * Adresa i token jsou ty z `spend-store.ts` (`sharedStoreFromEnv`), předpona
 * klíčů je ta z `storePrefix()`, protokol je REST Upstash (`SET … EX`, `GET`).
 * Bez sdíleného úložiště je to mapa v paměti procesu — pod `next start`
 * správně, na serverless jen po dobu života instance, a nikde se netvrdí víc.
 *
 * ⚠ **Síťový adaptér není naměřený proti živé službě** — táž výhrada jako
 * u knihy. Ověřený je port, deterministickým adaptérem v paměti a týmž testem.
 *
 * ## Poškozený záznam je miss, výpadek úložiště je miss
 *
 * Cache je úspora, ne podmínka: cokoli, co by z ní udělalo důvod k pádu
 * relace, je horší než jedno zaplacené volání navíc. `read()` proto nikdy
 * nevyhazuje a `write()` taky ne — obojí zapíše jeden řádek do logu
 * operátora a jede dál.
 */

import { createHash } from 'node:crypto';

import { buildIntentRequest } from '../model/worldstream-intent';
import { buildCompilerRequest, PROMPT_VERSION } from '../model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../model/worldstream-examples';

import { sharedStoreFromEnv, storePrefix } from './spend-store';
import { effortForCall, upstreamConfigFromEnv, type UpstreamConfig } from './upstream';

/** Sedm dní. Demo den je jeden; týden pokryje zkoušku, den D i dohru. */
export const ANSWER_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Kolik se čeká na úložiště při čtení i zápisu.
 *
 * Pod knihou stropu (2 s), protože cache stojí na kritické cestě **každé**
 * živé relace a vyprší-li, je to jen miss — ne odmítnutí. Vteřina je řádově
 * nad letem do téhož regionu a řádově pod tím, co porotce u „Writing the
 * world." postřehne.
 */
export const ANSWER_CACHE_TIMEOUT_MS = 1_000;

/** Přípona vedle `…:usd`, `…:calls` a `…:control` — čtvrtý druh klíče téže předpony. */
export const ANSWER_KEY_INFIX = ':answer:';

export interface CachedAnswer {
  /** Věta tak, jak ji model dostal — proti ní se uložený plán soudí, viz hlavička. */
  readonly sentence: string;
  /** Syrová odpověď plánovače, tak jak ji model napsal. */
  readonly planner: unknown;
  /** Syrová odpověď kompilátoru, **ta přijatá** — poslední kolo, ne první. */
  readonly compiler: unknown;
  /** ISO čas uložení. Do diagnostiky a do `reused.at` nejde — to je čas zásahu. */
  readonly storedAt: string;
}

/** Klíč → text. Port je záměrně tak malý, aby ho paměť i REST splnily stejně. */
export interface AnswerStore {
  readonly id: string;
  /** `null` znamená „klíč není". Vyhozená výjimka znamená „nevím" a cache ji čte jako miss. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface AnswerCache {
  readonly id: string;
  read(key: string): Promise<CachedAnswer | null>;
  write(key: string, answer: Pick<CachedAnswer, 'sentence' | 'planner' | 'compiler'>): Promise<void>;
}

/** Trim, jedna mezera, malá písmena — „doslova stejná věta" bez daně za překlep v mezerách. */
export function normalizeSentence(sentence: string): string {
  return sentence.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface AnswerKeyInput {
  readonly sentence: string;
  /** `PROMPT_VERSION` z `src/model/worldstream-prompt.ts`; test si dosadí vlastní. */
  readonly promptVersion: string;
  readonly model: string;
  /** Úsilí po fázi, tak jak ho `effortForCall` doopravdy pošle — ne hodnota z prostředí. */
  readonly effort: { readonly planner: string; readonly compiler: string };
  /** Koncový bod (nebo `codex-cli`). Jde jen do hashe, ven nikdy — může nést pověření. */
  readonly endpoint: string;
}

/**
 * SHA-256 nad celou otázkou. Řádkový oddělovač je schválně: bez něj by
 * `("ab", "c")` a `("a", "bc")` daly týž vstup.
 */
export function answerKey(input: AnswerKeyInput): string {
  return createHash('sha256')
    .update([normalizeSentence(input.sentence), input.promptVersion, input.model, input.effort.planner, input.effort.compiler, input.endpoint].join('\n'))
    .digest('hex');
}

/** Úložiště v paměti. `now` je vstřícnost k testům — sedm dní se odčekat nedá. */
export function memoryAnswerStore(now: () => number = Date.now, id = 'memory'): AnswerStore {
  const entries = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  return {
    id,
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return Promise.resolve(null);
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },
    set(key, value, ttlSeconds) {
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return Promise.resolve();
    },
  };
}

/**
 * Jedno úložiště na proces — na `globalThis` ze stejného naměřeného důvodu
 * jako kniha stropu: Next staví víc grafů modulů a modulová proměnná by byla
 * cache na graf, ne na proces.
 */
const PROCESS_STORE_KEY = '__worldsmithAnswerStore';

export function processAnswerStore(): AnswerStore {
  const holder = globalThis as Record<string, unknown>;
  holder[PROCESS_STORE_KEY] ??= memoryAnswerStore(Date.now, 'process-memory');
  return holder[PROCESS_STORE_KEY] as AnswerStore;
}

/** Jen pro testy. */
export function resetProcessAnswerStore(): void {
  delete (globalThis as Record<string, unknown>)[PROCESS_STORE_KEY];
}

export interface HttpAnswerStoreConfig {
  readonly url: string;
  readonly token: string;
  /** Táž předpona jako u knihy; klíč je `${prefix}:answer:${sha}`. */
  readonly prefix: string;
  readonly timeoutMs: number;
}

/** Úložiště přes REST Upstash. `SET key value EX ttl` jedním příkazem, `GET` druhým. */
export function httpAnswerStore(config: HttpAnswerStoreConfig, fetchImpl: typeof fetch = fetch): AnswerStore {
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  const fullKey = (key: string): string => `${config.prefix}${ANSWER_KEY_INFIX}${key}`;

  return {
    id: 'http',
    async get(key) {
      const response = await fetchImpl(`${config.url}/get/${encodeURIComponent(fullKey(key))}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      // Bez těla odpovědi — chybová stránka úložiště nese adresu i klíč.
      if (!response.ok) throw new Error(`answer cache answered ${String(response.status)}`);
      const result = ((await response.json()) as { result?: unknown }).result;
      if (result === null || result === undefined) return null;
      if (typeof result !== 'string') throw new Error('answer cache answered a shape this server cannot read');
      return result;
    },
    async set(key, value, ttlSeconds) {
      const response = await fetchImpl(`${config.url}/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(['SET', fullKey(key), value, 'EX', String(ttlSeconds)]),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`answer cache answered ${String(response.status)}`);
    },
  };
}

function isCachedAnswer(value: unknown): value is CachedAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'planner' in value &&
    'compiler' in value &&
    typeof (value as { sentence?: unknown }).sentence === 'string' &&
    typeof (value as { storedAt?: unknown }).storedAt === 'string'
  );
}

/** Cache nad úložištěm. Nikdy nevyhazuje — viz hlavička. */
export function answerCache(
  store: AnswerStore,
  log: (line: string) => void = (line) => console.warn(`[worldstream] ${line}`),
): AnswerCache {
  return {
    id: store.id,
    async read(key) {
      let raw: string | null;
      try {
        raw = await store.get(key);
      } catch (thrown) {
        log(`the answer cache could not be read; treating it as a miss: ${String(thrown)}`);
        return null;
      }
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isCachedAnswer(parsed)) return parsed;
      } catch {
        // Spadá do téže věty níž: rozbitý JSON i špatný tvar jsou jeden případ.
      }
      log('the answer cache holds a record this server cannot read; treating it as a miss');
      return null;
    },
    async write(key, answer) {
      const record: CachedAnswer = { sentence: answer.sentence, planner: answer.planner, compiler: answer.compiler, storedAt: new Date().toISOString() };
      try {
        await store.set(key, JSON.stringify(record), ANSWER_TTL_SECONDS);
      } catch (thrown) {
        log(`the answer cache could not be written: ${String(thrown)}`);
      }
    },
  };
}

/**
 * Cache podle prostředí, nebo `null`, když je vypnutá.
 *
 * `WORLDSMITH_ANSWER_CACHE=off` je jediný vypínač a znamená **žádný objekt**,
 * ne cache, která vždycky mine: co neexistuje, to nic nečte ani nepíše.
 * Sdílené úložiště se pozná stejně jako u knihy; bez něj je to paměť procesu.
 */
export function answerCacheFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): AnswerCache | null {
  if ((env.WORLDSMITH_ANSWER_CACHE ?? '').trim().toLowerCase() === 'off') return null;
  const shared = sharedStoreFromEnv(env);
  const store =
    shared === null
      ? processAnswerStore()
      : httpAnswerStore({ url: shared.url, token: shared.token, prefix: storePrefix(env), timeoutMs: ANSWER_CACHE_TIMEOUT_MS }, fetchImpl);
  return answerCache(store);
}

/**
 * Cache a klíč téhle věty pro `runGeneration`, nebo prázdný objekt.
 *
 * Model, úsilí a koncový bod jsou z téže konfigurace, ze které
 * `cloudEmitter()` staví větev — jiná odpověď na „který model" v repu není.
 * Úsilí se neopisuje z `config.effort`, ale ptá se **téže funkce, která ho
 * pošle** (`effortForCall`), nad požadavkem téže fáze: kdyby se tabulka
 * `STAGE_EFFORT` hnula, hne se i klíč. Prázdný objekt (ne `null`) proto,
 * aby se dal rozbalit rovnou do `GenerationDeps`: bez konfigurace nebo
 * s vypnutou cache se `answers` prostě nepředá.
 */
export function answerReuseFor(
  env: Record<string, string | undefined>,
  sentence: string,
): { readonly answers?: { readonly cache: AnswerCache; readonly key: string } } {
  const cache = answerCacheFromEnv(env);
  const config = upstreamConfigFromEnv(env);
  if (cache === null || config === null) return {};
  return {
    answers: {
      cache,
      key: answerKey({ sentence, promptVersion: PROMPT_VERSION, model: config.model, effort: sentEfforts(sentence, config), endpoint: config.endpoint }),
    },
  };
}

/**
 * Úsilí, které by obě fáze **poslaly**. Požadavky se staví doopravdy
 * (`effortForCall` čte fázi z textu), kompilátorový nad ukázkovým plánem
 * a značkou místo grammar — na úsilí má vliv jen fáze, ne obsah.
 */
function sentEfforts(sentence: string, config: UpstreamConfig): AnswerKeyInput['effort'] {
  const mark = ['<grammar>'] as const;
  const compiler = buildCompilerRequest(EXAMPLE_PLAN, { surfaceEvents: mark, conditions: mark, actions: mark, simFields: mark, lookFields: mark });
  return {
    planner: effortForCall({ prompt: sentence, request: buildIntentRequest(sentence) }, config),
    compiler: effortForCall({ prompt: sentence, request: compiler }, config),
  };
}
