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
/** Horní mez rozpočtu: měření obrazu čte s 60 s, `codex-cli` čte desítky sekund. */
const MAX_READER_BUDGET_MS = 120_000;
/**
 * Výstup čtení je ~200 tokenů a gpt-oss k němu na `low` uvažuje. Je to i strop
 * rezervace: na Groq gpt-oss-20b (0,30 USD za Mtok výstupu) ~0,0003 USD.
 */
const READER_MAX_OUTPUT_TOKENS = 1024;

/**
 * Čtení před draftem je zapnuté jen `PLAY_READER=on` s endpointem (objednávka);
 * jestli má čím jet, rozhodne až `readerConfigFromEnv`.
 */
export function readerEnabled(env: Env = process.env): boolean {
  return env.PLAY_READER === 'on' && (env.PLAY_READER_ENDPOINT ?? '') !== '';
}

function readerBudgetMs(env: Env): number {
  const budget = Number(env.PLAY_READER_BUDGET_MS);
  return Number.isInteger(budget) && budget > 0 && budget <= MAX_READER_BUDGET_MS ? budget : DEFAULT_READER_BUDGET_MS;
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
  const timeoutMs = readerBudgetMs(env);
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
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, config.timeoutMs);
  });
  try {
    return await Promise.race([readThrough(text, config, env, deps, controller.signal), budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function readThrough(text: string, config: UpstreamConfig, env: Env, deps: ReaderDeps, signal: AbortSignal): Promise<Reading | null> {
  try {
    const store = deps.store === undefined ? answerStoreFromEnv(env, deps.fetchImpl ?? fetch) : deps.store;
    const key = readerCacheKey({ sentence: text, promptVersion: readerPromptVersion(), model: config.model, endpoint: config.endpoint });
    const cached = store === null ? null : await cachedReading(store, key);
    if (cached !== null) return cached;
    const reading = await callReader(text, config, env, deps, signal);
    // Zápis neblokuje: hotové čtení nesmí propadnout rozpočtu kvůli úložišti.
    if (reading !== null && store !== null) void store.set(key, JSON.stringify(reading), ANSWER_TTL_SECONDS).catch(() => undefined);
    return reading;
  } catch {
    return null;
  }
}

async function cachedReading(store: AnswerStore, key: string): Promise<Reading | null> {
  try {
    const raw = await store.get(key);
    if (raw === null) return null;
    const parsed = readingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Volání modelu. Placené (`openai:`) jde přes vypínač a procesní strop režiséra:
 * rezervace nejhoršího případu před voláním, vyrovnání skutečnou cenou po něm,
 * bez účtenky celou rezervací. Odmítnutí stropem = `null` bez volání.
 */
async function callReader(text: string, config: UpstreamConfig, env: Env, deps: ReaderDeps, signal: AbortSignal): Promise<Reading | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const call: GenerationCall = { prompt: text, request: { model: config.model, system: readerSystemPrompt(), user: text, outputSchema: READING_JSON_SCHEMA } };
  const branch = upstreamBranch(config, fetchImpl);
  const worstCaseUsd = branch.worstCaseUsd(call);
  if (worstCaseUsd <= 0) return readingOf(await branch.generate(call, signal));

  // Placeně jen za známého volajícího (revize T4): režisér na pozadí volajícího nepředá, takže větu znovu nezaplatí.
  if (deps.caller === undefined) return null;
  if ((await killState(env, fetchImpl)).upstream) return null;
  const reservation = await (deps.cap ?? processReaderSpendCap()).reserve(worstCaseUsd);
  if (!reservation.ok) return null;
  // Počet volajícího až po rezervaci (jako režisér, R8); rozpočet vypršel = volání neodejde, nic se neutratilo.
  if (signal.aborted || !(await callerMayRead(deps.caller, env)) || signal.aborted) {
    await reservation.settle(0);
    return null;
  }
  let outcome: GenerationOutcome | null = null;
  try {
    outcome = await branch.generate(call, signal);
  } finally {
    await reservation.settle(outcome === null || outcome.usage === null ? 'unknown' : costUsd(outcome.usage, config.pricing));
  }
  return readingOf(outcome);
}

function readingOf(outcome: GenerationOutcome): Reading | null {
  if (!outcome.ok) return null;
  const parsed = readingSchema.safeParse(outcome.body);
  return parsed.success ? parsed.data : null;
}
