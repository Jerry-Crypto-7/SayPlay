/**
 * Čtečka věty (P29B T2, P56A T4): jedno volání modelu přes transporty režiséra
 * (`src/server/upstream.ts`) – `llamacpp:` lokální gpt-oss, `openai:` hostovaný
 * poskytovatel (Groq ve veřejném demu), `codex-cli` předplatné – s odpovědí pod
 * schématem `READING_JSON_SCHEMA`.
 *
 * Běží bez dozoru na každé větě, proto nikdy nehází: timeout, chyba sítě,
 * HTTP chyba, nečitelný JSON, porušený kontrakt, odmítnutý strop i chybějící
 * klíč vrací `null` a draft pak čte větu klíčovými slovy jako dřív.
 * `PLAY_READER=off` čtečku vypne úplně.
 */

import { createHash } from 'node:crypto';

import { EMISSION_MODEL } from '../../model/prompt';
import { ANSWER_TTL_SECONDS, answerStoreFromEnv, normalizeSentence, type AnswerStore } from '../../server/answer-cache';
import { killState } from '../../server/kill-switch';
import type { GenerationCall, GenerationOutcome } from '../../server/pipeline';
import { costUsd, processReaderSpendCap, type SpendCap } from '../../server/spend-cap';
import { chatConfigFromEnv, CODEX_CLI_ENDPOINT, LLAMACPP_PREFIX, upstreamBranch, type UpstreamConfig } from '../../server/upstream';
import { versionStoreFromEnv } from '../version';
import { readerSystemPrompt } from './prompt';
import { READING_JSON_SCHEMA, readingSchema, type Reading } from './schema';

type Env = Record<string, string | undefined>;

export interface ReadOptions {
  /** Kořen `llama-server`, např. `http://127.0.0.1:8791`; prázdný = čtečka není. */
  readonly endpoint: string;
  readonly timeoutMs: number;
}

/** Co si test nebo měření dosadí; výchozí jsou tytéž kusy, které používá režisér. */
export interface ReaderDeps {
  readonly fetchImpl?: typeof fetch;
  /** `null` = bez cache. Chybí = úložiště cache odpovědí podle prostředí. */
  readonly store?: AnswerStore | null;
  /** Chybí = vlastní procesní strop čtečky (`processReaderSpendCap()`), ne strop režiséra. */
  readonly cap?: Pick<SpendCap, 'reserve'>;
  /** Volající (route tvorby); placené čtení bez něj neodejde a jeho denní počet drží `PLAY_READER_CALLS_PER_CALLER`. */
  readonly caller?: string;
  /** Volající čtení vzdal (route spadla, T10-R1): jako vypršený rozpočet – `null`, placené volání neodejde. */
  readonly signal?: AbortSignal;
  /**
   * Model se ptal – placeně i zdarma – nebo cache vrátila zaplacené prázdné čtení (P58E T5): práce řetězu si pak drží
   * i prázdné čtení, ať ho nezaplatí podruhé. Bez tohohle čtení odmítla brána nebo strop a nic se neutratilo.
   */
  readonly onCalled?: () => void;
}

/** Placených čtení na volajícího za den, když `PLAY_READER_CALLS_PER_CALLER` chybí nebo nedává smysl. */
export const DEFAULT_READS_PER_CALLER = 30;

/** Denní počítadlo volajícího vedle kvóty režiséra (klíč `reader:<volající>`); nedostupné úložiště čtení nepustí. */
async function callerMayRead(caller: string, env: Env): Promise<boolean> {
  const limit = Number(env.PLAY_READER_CALLS_PER_CALLER);
  try {
    return await versionStoreFromEnv(env).takeDirectorCall(`reader:${caller}`, Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_READS_PER_CALLER);
  } catch {
    return false;
  }
}

/**
 * Rozpočet čtení před draftem, když `PLAY_READER_BUDGET_MS` chybí nebo nedává
 * smysl. 700 ms je cíl P56A pro rychlou cestu; po něm draft ze slov.
 */
export const DEFAULT_READER_BUDGET_MS = 700;
/**
 * Výchozí rozpočet lokálního `llama-server` (`llamacpp:` i holá adresa): gpt-oss-20b
 * tu čte p50 3,3 s a p95 7,9 s (`evals/play/p56a/readings/*.json`, 342 vět, T4-R1),
 * takže s 700 ms by vrátil `null` skoro vždy. Codex CLI zůstává na 700 ms (změřené
 * číslo nemá); čte desítky sekund, rozpočet mu dá až `PLAY_READER_BUDGET_MS`.
 */
export const DEFAULT_LOCAL_READER_BUDGET_MS = 8000;
/**
 * Výchozí rozpočet čtení pro AI verzi (`PLAY_READER_PATH=ai`): astra přes OpenAI API čte
 * p95 6,4 s a nejpomalejší z 220 vět 9,1 s (`evals/play/p58b/README.md`). AI verze běží
 * desítky sekund, takže 15 s ji nebrzdí a vypršení je výjimka, ne pravidlo.
 */
export const DEFAULT_AI_READER_BUDGET_MS = 15_000;
/** Horní mez rozpočtu: měření obrazu čte s 60 s, `codex-cli` čte desítky sekund. */
const MAX_READER_BUDGET_MS = 120_000;
/**
 * Výstup čtení je ~200 tokenů a gpt-oss k němu na `low` uvažuje. Je to i strop
 * rezervace: na Groq gpt-oss-20b (0,30 USD za Mtok výstupu) ~0,0003 USD.
 */
export const READER_MAX_OUTPUT_TOKENS = 1024;

/**
 * Čtení před draftem je zapnuté jen `PLAY_READER=on` s endpointem (objednávka);
 * jestli má čím jet, rozhodne až `readerConfigFromEnv`.
 */
export function readerEnabled(env: Env = process.env): boolean {
  return env.PLAY_READER === 'on' && (env.PLAY_READER_ENDPOINT ?? '') !== '';
}

/**
 * Čtečka jen pro AI verzi (`PLAY_READER_PATH=ai`, P58B T3): žádný změřený hostovaný model
 * nečte pod 1 000 ms, takže route na čtení nečeká a rychlou hru staví slovník. Čte až režisér
 * na pozadí, placeně za volajícího, jehož věta AI verzi spustila.
 */
export function readerForAiVersion(env: Env = process.env): boolean {
  return readerEnabled(env) && env.PLAY_READER_PATH === 'ai';
}

function readerBudgetMs(env: Env, fallback: number): number {
  const budget = Number(env.PLAY_READER_BUDGET_MS);
  return Number.isInteger(budget) && budget > 0 && budget <= MAX_READER_BUDGET_MS ? budget : fallback;
}

/**
 * Konfigurace čtečky z `PLAY_READER_*`, nebo `null` = čtečka nejede.
 *
 * `openai:` bez klíče, modelu nebo kladné ceny výstupu je nekonfigurace (táž
 * doktrína jako placená záloha režiséra), takže placená čtečka nikdy nevolá bez
 * ceny. Holá adresa je `llama-server` z P29B. Timeout volání je celý rozpočet.
 */
export function readerConfigFromEnv(env: Env = process.env): UpstreamConfig | null {
  const endpoint = (env.PLAY_READER_ENDPOINT ?? '').trim();
  const local = endpoint.startsWith(LLAMACPP_PREFIX) || /^https?:\/\//.test(endpoint);
  const timeoutMs = readerBudgetMs(env, local ? DEFAULT_LOCAL_READER_BUDGET_MS : env.PLAY_READER_PATH === 'ai' ? DEFAULT_AI_READER_BUDGET_MS : DEFAULT_READER_BUDGET_MS);
  if (endpoint === CODEX_CLI_ENDPOINT)
    return {
      endpoint,
      apiKey: '',
      model: (env.PLAY_READER_MODEL ?? '').trim() || EMISSION_MODEL,
      effort: 'low',
      pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
      maxOutputTokens: READER_MAX_OUTPUT_TOKENS,
      timeoutMs,
      profile: 'subscription',
      callCap: null,
    };
  const prefixed = /^https?:\/\//.test(endpoint) ? { ...env, PLAY_READER_ENDPOINT: `${LLAMACPP_PREFIX}${endpoint}` } : env;
  const config = chatConfigFromEnv(prefixed, 'PLAY_READER', {
    localModel: 'local-reader',
    localMaxOutputTokens: READER_MAX_OUTPUT_TOKENS,
    hostedMaxOutputTokens: READER_MAX_OUTPUT_TOKENS,
    timeoutMs,
  });
  return config === null ? null : { ...config, timeoutMs };
}

/** Otisk promptu i schématu: změna kteréhokoli je nové čtení, ne staré z cache. */
let promptVersion: string | undefined;
export function readerPromptVersion(): string {
  promptVersion ??= createHash('sha256').update(readerSystemPrompt()).update('\n').update(JSON.stringify(READING_JSON_SCHEMA)).digest('hex').slice(0, 16);
  return promptVersion;
}

export interface ReaderKeyInput {
  readonly sentence: string;
  readonly promptVersion: string;
  readonly model: string;
  /** Jde jen do hashe, ven nikdy. */
  readonly endpoint: string;
}

/** Klíč čtení. Předpona `reader:` drží čtení mimo odpovědi režiséra v témže úložišti. */
export function readerCacheKey(input: ReaderKeyInput): string {
  const digest = createHash('sha256')
    .update([normalizeSentence(input.sentence), input.promptVersion, input.model, input.endpoint].join('\n'))
    .digest('hex');
  return `reader:${digest}`;
}

/** Čtení věty pro draft route a režiséra; vypnutá nebo nenakonfigurovaná čtečka = `null` bez volání. */
export async function readBeforeDraft(text: string, env: Env = process.env, deps: ReaderDeps = {}): Promise<Reading | null> {
  if (!readerEnabled(env)) return null;
  const config = readerConfigFromEnv(env);
  if (config === null) return null;
  return readWithin(text, config, env, deps);
}

/** Jedno čtení z `llama-server` bez cache (měření P29B, `scripts/play-fidelity.mjs`). */
export async function readSentence(text: string, { endpoint, timeoutMs }: ReadOptions): Promise<Reading | null> {
  if (process.env.PLAY_READER === 'off' || endpoint === '') return null;
  const config = readerConfigFromEnv({ PLAY_READER_ENDPOINT: endpoint, PLAY_READER_BUDGET_MS: String(timeoutMs) });
  return config === null ? null : readWithin(text, config, {}, { store: null });
}

/** Čtení v rozpočtu `config.timeoutMs`: po něm `null`, ať cache, strop nebo model odpovídají cokoli. */
async function readWithin(text: string, config: UpstreamConfig, env: Env, deps: ReaderDeps): Promise<Reading | null> {
  // `setTimeout`, ne `AbortSignal.timeout`: rozpočet pak drží i falešné hodiny testu.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    const giveUp = () => {
      controller.abort();
      resolve(null);
    };
    timer = setTimeout(giveUp, config.timeoutMs);
    deps.signal?.addEventListener('abort', giveUp, { once: true });
  });
  try {
    return await Promise.race([readThrough(text, config, env, deps, controller.signal), budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function readThrough(text: string, config: UpstreamConfig, env: Env, deps: ReaderDeps, signal: AbortSignal): Promise<Reading | null> {
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const store = deps.store === undefined ? answerStoreFromEnv(env, fetchImpl) : deps.store;
    const key = readerCacheKey({ sentence: text, promptVersion: readerPromptVersion(), model: config.model, endpoint: config.endpoint });
    const call: GenerationCall = { prompt: text, request: { model: config.model, system: readerSystemPrompt(), user: text, outputSchema: READING_JSON_SCHEMA } };
    const branch = upstreamBranch(config, fetchImpl);
    const worstCaseUsd = branch.worstCaseUsd(call);
    // Vypínač jen čte, takže na placené cestě letí souběžně s cache (T4-R1); nepřečtený = vypnuto.
    const killed = worstCaseUsd > 0 && deps.caller !== undefined ? killState(env, fetchImpl).then((state) => state.upstream, () => true) : Promise.resolve(false);
    const cached = store === null ? undefined : await cachedReading(store, key);
    if (cached !== undefined) {
      // Prázdné čtení v cache je vždy zaplacené (zdarma se `null` nepamatuje) – jiným procesem nebo před restartem.
      if (cached === null) deps.onCalled?.();
      return cached;
    }
    // `undefined` = nic neodešlo. Zdarma (lokální čtečka) se `null` nepamatuje: další pokus nic nestojí.
    if (worstCaseUsd <= 0) deps.onCalled?.();
    const reading = worstCaseUsd <= 0 ? (readingOf(await branch.generate(call, signal)) ?? undefined) : await paidReading(call, branch, worstCaseUsd, killed, config, env, deps, signal);
    // Zápis neblokuje: hotové čtení nesmí propadnout rozpočtu kvůli úložišti. Zaplacené `null` (vypršení se účtuje
    // celé, useknutá odpověď) jde do cache nakrátko, ať ho druhý běh režiséra ani opakovaný upgrade nezaplatí znovu (T4a),
    // a jen do prázdného klíče: souběžné čtení téže věty, které uspělo dřív, nepřepíše (revize T4a/T4b).
    if (reading !== undefined && store !== null) void store.set(key, JSON.stringify(reading), reading === null ? READER_MISS_TTL_SECONDS : ANSWER_TTL_SECONDS, { onlyIfAbsent: reading === null }).catch(() => undefined);
    return reading ?? null;
  } catch {
    return null;
  }
}

/**
 * Jak dlouho cache drží zaplacené čtení, které nevyšlo (T4a). AI verze přijde p50 za 57 s (T7) a fronta
 * na slot ji zdrží o minuty: deset minut kryje druhý běh s pokynem i opakování po dočasné chybě, a tutéž
 * větu za hodinu čtečka přečte znovu.
 */
export const READER_MISS_TTL_SECONDS = 10 * 60;

/** `undefined` = v cache nic použitelného; `null` = zaplacené čtení, které nevyšlo, ještě v `READER_MISS_TTL_SECONDS`. */
async function cachedReading(store: AnswerStore, key: string): Promise<Reading | null | undefined> {
  try {
    const raw = await store.get(key);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (value === null) return null;
    const parsed = readingSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Placené volání (`openai:`) přes vypínač a vlastní strop čtečky: rezervace
 * nejhoršího případu před voláním, vyrovnání skutečnou cenou po něm, bez
 * účtenky celou rezervací. Odmítnutí stropem = `undefined` bez volání; volání,
 * které odešlo a čtení nevrátilo (i přerušené rozpočtem), = `null`.
 */
async function paidReading(
  call: GenerationCall,
  branch: ReturnType<typeof upstreamBranch>,
  worstCaseUsd: number,
  killed: Promise<boolean>,
  config: UpstreamConfig,
  env: Env,
  deps: ReaderDeps,
  signal: AbortSignal,
): Promise<Reading | null | undefined> {
  // Placeně jen za známého volajícího (revize T4): režisér na pozadí ho předá jen u čtečky pro AI verzi (P58B T4),
  // kde route nečetla – jinak by větu, kterou route už četla, zaplatil podruhé.
  if (deps.caller === undefined) return undefined;
  if ((await killed) || signal.aborted) return undefined;
  // Kniha stropu a počet volajícího letí souběžně (T4-R1), ať z rozpočtu zbude modelu: před voláním
  // jsou tak dva lety, ne čtyři (první čtení volajícího za den tři: INCR a EXPIRE). Daň: odmítnutí
  // stropem i rozpočet, který vyprší během těch letů, volajícímu spálí jedno čtení dne bez volání.
  const [reservation, mayRead] = await Promise.all([(deps.cap ?? processReaderSpendCap()).reserve(worstCaseUsd), callerMayRead(deps.caller, env)]);
  if (!reservation.ok) return undefined;
  // Rozpočet vypršel = volání neodejde, nic se neutratilo.
  if (signal.aborted || !mayRead) {
    await reservation.settle(0);
    return undefined;
  }
  // Spadlé nebo přerušené volání odešlo: účtuje se celou rezervací a čtení je `null`, ne „nic neodešlo“.
  deps.onCalled?.();
  const outcome: GenerationOutcome | null = await branch.generate(call, signal).catch(() => null);
  await reservation.settle(outcome === null || outcome.usage === null ? 'unknown' : costUsd(outcome.usage, config.pricing));
  return outcome === null ? null : readingOf(outcome);
}

function readingOf(outcome: GenerationOutcome): Reading | null {
  if (!outcome.ok) return null;
  const parsed = readingSchema.safeParse(outcome.body);
  return parsed.success ? parsed.data : null;
}
