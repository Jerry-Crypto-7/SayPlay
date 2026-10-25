/**
 * P58B T2: tatáž věta každé čtečce se **stejným** promptem a schématem (`readerSystemPrompt()`, `READING_JSON_SCHEMA`).
 * Po větách zapíše čtení, žánr po `classifyGenre`, role, latenci (první bajt i celek), tokeny a cenu; souhrn po modelech:
 * žánr cílů, pasti, p50/p95, cena, neplatné odpovědi.
 *
 * ```
 * node --env-file-if-exists=.env.local --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p58b/compare.measure.ts \
 *   --models gpt-oss-20b@groq,gpt-oss-120b@cerebras,claude-cli:opus --set evals/play/p56a/holdout.json,evals/play/p55/holdout.json --cap-usd 2 [--out <soubor>]
 * ```
 *
 * - Hostované modely s OpenAI API jdou týmž transportem jako produkt (`upstreamBranch`, `openai:`), Anthropic API
 *   vlastním adaptérem (`anthropicReader`; produktová cesta Messages schéma neposílá). Klíč z proměnné kandidáta
 *   (`CANDIDATES`, např. `OPENAI_API_KEY`) – ven nikdy. Volání má 30 s; rozpočet 700 ms se tu neuplatní, latence se jen zapíše.
 * - `claude-cli:opus` je strop kvality, ne kandidát: `claude -p` na předplatné (`ANTHROPIC_API_KEY` se dítěti nepředá),
 *   jeho cena je přepočet z ceníku (`listUsd`) a do `--cap-usd` se nepočítá.
 * - `--cap-usd` je povinný: před každým placeným voláním se rezervuje nejhorší případ, a nevejde-li se pod strop, běh
 *   skončí (`stoppedBy: 'cap'`). Odpověď bez účtenky se účtuje nejhorším případem.
 * - Neplatná odpověď (HTTP chyba, nečitelný JSON, porušené schéma) je **chyba**, ne slovník: žánr `null`, věta se
 *   počítá jako minutá. Bez toho by model, který neodpovídá, sbíral body slovníku.
 * - Zapečetěnou sadu (`holdout.json` bez `holdout-opened.json` vedle) odmítne – ta se otevírá jen svým měřením brány.
 * - Věty jdou po řadě a u každé všechny modely za sebou: strop pak utne všem modelům tutéž větu.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyGenre } from '../../../src/play/genre/classify';
import { readerPromptVersion } from '../../../src/play/read/client';
import { readerSystemPrompt } from '../../../src/play/read/prompt';
import { READING_JSON_SCHEMA, readingSchema, type Reading } from '../../../src/play/read/schema';
import type { GenerationCall } from '../../../src/server/pipeline';
import { costUsd, type Pricing, type Usage } from '../../../src/server/spend-cap';
import { upstreamBranch, type Effort, type UpstreamConfig } from '../../../src/server/upstream';

import { P55_GENRES } from '../p55/seal';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Strop výstupu jako v čtečce (`READER_MAX_OUTPUT_TOKENS` v `client.ts`); z něj je i nejhorší případ rezervace. */
const MAX_OUTPUT_TOKENS = 1024;
const HOSTED_TIMEOUT_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 180_000;
/** Hranice latence brány P58B (p95 ≤ 1 000 ms) a rozpočet rychlé cesty (700 ms). */
const GATE_MS = 1000;
const BUDGET_MS = 700;

export interface Candidate {
  readonly id: string;
  readonly kind: 'openai' | 'anthropic' | 'claude-cli';
  /** `openai:<kořen bez /v1>` u OpenAI API; celá adresa Messages u `anthropic`; u `claude-cli` prázdné. */
  readonly endpoint: string;
  readonly model: string;
  /** Proměnná s klíčem poskytovatele; `null` u `claude-cli`. */
  readonly keyEnv: string | null;
  readonly effort: Effort;
  /** Ceník za Mtok; u `claude-cli` nula (předplatné). */
  readonly pricing: Pricing;
  /** Jen `anthropic`: cena zápisu a čtení cache jako násobek ceny vstupu. */
  readonly cache?: { readonly write: number; readonly read: number };
  /** Pole těla navíc nebo pryč u poskytovatele, který jinak uvažování nevypne. */
  readonly body?: { readonly omit?: readonly string[]; readonly set?: Readonly<Record<string, unknown>> };
}

/**
 * Kandidáti T3. Jména modelů a ceny jsou z veřejných ceníků k 23. 10. 2026 (Cerebras: Qwen3.8-27B 0,99/1,49, gpt-oss-120b
 * 0,35/0,75 USD za Mtok) – před placeným během je ověř na stránce poskytovatele; špatné jméno skončí čtyřistovkou
 * (`error: 'rejected'`), ne tichým číslem. Qwen má uvažování vypnuté polem těla `disable_reasoning` – neověřené, T3 ho
 * potvrdí prvním voláním (poskytovatel neznámé pole odmítne, nebo odpoví s tokeny uvažování ve `completion_tokens`).
 */
export const CANDIDATES: Readonly<Record<string, Candidate>> = {
  'qwen3.8-27b@cerebras': {
    id: 'qwen3.8-27b@cerebras', kind: 'openai', endpoint: 'openai:https://api.cerebras.ai', model: 'qwen-3.8-27b', keyEnv: 'CEREBRAS_API_KEY', effort: 'low',
    pricing: { usdPerMTokIn: 0.99, usdPerMTokOut: 1.49 }, body: { omit: ['reasoning_effort'], set: { disable_reasoning: true } },
  },
  'gpt-oss-120b@cerebras': {
    id: 'gpt-oss-120b@cerebras', kind: 'openai', endpoint: 'openai:https://api.cerebras.ai', model: 'gpt-oss-120b', keyEnv: 'CEREBRAS_API_KEY', effort: 'low',
    pricing: { usdPerMTokIn: 0.35, usdPerMTokOut: 0.75 },
  },
  'gpt-oss-20b@groq': {
    id: 'gpt-oss-20b@groq', kind: 'openai', endpoint: 'openai:https://api.groq.com/openai', model: 'openai/gpt-oss-20b', keyEnv: 'GROQ_API_KEY', effort: 'low',
    pricing: { usdPerMTokIn: 0.075, usdPerMTokOut: 0.3 },
  },
  'claude-cli:opus': {
    id: 'claude-cli:opus', kind: 'claude-cli', endpoint: '', model: 'claude-opus-5-5', keyEnv: null, effort: 'low', pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
  },
  // T3 po rozhodnutí majitele 23. 10. srovnává jen tyhle dva. Opus 5.5: 4/20 USD za Mtok, čtení cache 0,05×, zápis 1,25×
  // (ceník Anthropicu k 6. 10. 2026). Astra: 10/50 USD za Mtok podle ceníkových přehledů k 11. 10. 2026; automatickou
  // slevu OpenAI za cache produktová cesta nevidí, takže její útrata je horní mez.
  'opus-5.5@anthropic': {
    id: 'opus-5.5@anthropic', kind: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-5-5', keyEnv: 'ANTHROPIC_API_KEY', effort: 'low',
    pricing: { usdPerMTokIn: 4, usdPerMTokOut: 20 }, cache: { write: 1.25, read: 0.05 },
  },
  'astra@openai': {
    id: 'astra@openai', kind: 'openai', endpoint: 'openai:https://api.openai.com', model: 'gpt-6-astra', keyEnv: 'OPENAI_API_KEY', effort: 'low',
    pricing: { usdPerMTokIn: 10, usdPerMTokOut: 50 },
  },
};

/** Věta sady: cíl nese `genre` (s režimem nebo bez), past `lure`; past P55 (`distractor`) žádný `lure` nemá. */
export interface SetSentence {
  readonly id: string;
  readonly text: string;
  readonly family?: string;
  readonly genre?: string | null;
  readonly lure?: string | null;
  readonly hero?: string | null;
  readonly foe?: string | null;
}
export interface SentenceSet { readonly name: string; readonly sentences: readonly SetSentence[] }

/** Co vrátí `claude -p`: tělo odpovědi, nebo proč žádné. `listUsd` = přepočet z ceníku, ne útrata. */
export type ClaudeOutcome =
  | { readonly ok: true; readonly body: unknown; readonly usage: Usage | null; readonly listUsd: number | null; readonly firstByteMs: number | null }
  | { readonly ok: false; readonly detail: string; readonly listUsd: number | null };
export type ClaudeRunner = (input: { readonly model: string; readonly system: string; readonly user: string; readonly schema: Readonly<Record<string, unknown>>; readonly timeoutMs: number }) => Promise<ClaudeOutcome>;

export interface CompareDeps {
  readonly fetchImpl?: typeof fetch;
  readonly runClaude?: ClaudeRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export type ReadError = 'unavailable' | 'rejected' | 'invalid';

export interface ModelRead {
  readonly error: ReadError | null;
  readonly detail: string | null;
  readonly reading: Reading | null;
  /** Žánr, který čtení samo řeklo. */
  readonly readGenre: string | null;
  /** Žánr po `classifyGenre` (první v pořadí); u chyby `null` – slovník se tu nepočítá. */
  readonly classified: string | null;
  /** Cíl: žánr sedí; past: hra nejde na lákavý žánr. `null` = věta bez štítku. Chyba je vždy `false`. */
  readonly hit: boolean | null;
  readonly modeHit: boolean | null;
  readonly firstByteMs: number | null;
  readonly totalMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Placená útrata volání (u odpovědi bez účtenky nejhorší případ). */
  readonly usd: number;
  /** Přepočet z ceníku u předplatného (`claude-cli`). */
  readonly listUsd: number | null;
}

export interface CompareRow {
  readonly set: string;
  readonly id: string;
  readonly kind: 'target' | 'trap' | 'unlabeled';
  readonly label: string | null;
  readonly lure: string | null;
  readonly models: Record<string, ModelRead>;
}

const fullMode = (genre: string | null | undefined): string | null => (genre == null ? null : genre.includes('.') ? genre : `${genre}.default`);
const genreOf = (mode: string | null): string | null => (mode === null ? null : mode.split('.')[0]!);
const kindOf = (sentence: SetSentence): CompareRow['kind'] => {
  if (sentence.family === undefined || sentence.family === 'target') return fullMode(sentence.genre) === null ? 'unlabeled' : 'target';
  return 'trap';
};

/** Cíl: žánr (bez režimu) sedí. Past s `lure`: hra nejde přesně na lákavý režim (pravidlo P56A). Past P55 bez `lure`: nehraje nový žánr P54C. */
export function scoreOf(sentence: SetSentence, classified: string | null): { hit: boolean | null; modeHit: boolean | null } {
  const kind = kindOf(sentence);
  if (kind === 'unlabeled') return { hit: null, modeHit: null };
  if (classified === null) return { hit: false, modeHit: false };
  if (kind === 'target') return { hit: genreOf(classified) === genreOf(fullMode(sentence.genre)), modeHit: classified === fullMode(sentence.genre) };
  if (sentence.lure != null) return { hit: classified !== fullMode(sentence.lure), modeHit: genreOf(classified) !== genreOf(fullMode(sentence.lure)) };
  const offNew = !(P55_GENRES as readonly string[]).includes(genreOf(classified)!);
  return { hit: offNew, modeHit: offNew };
}

/** Sada vět ze souboru; zapečetěný `holdout.json` (bez `holdout-opened.json` vedle) odmítne. */
export function loadSet(path: string): SentenceSet {
  const file = resolve(ROOT, path);
  if (basename(file) === 'holdout.json' && !existsSync(join(dirname(file), 'holdout-opened.json')))
    throw new Error(`${relative(ROOT, file)} is sealed (no holdout-opened.json beside it) – only its gate measurement opens it`);
  const json = JSON.parse(readFileSync(file, 'utf8')) as { sentences: SetSentence[] };
  return { name: `${basename(dirname(file))}/${basename(file, '.json')}`, sentences: json.sentences };
}

/** Fetch, který tělo upraví podle kandidáta a změří čas do prvního bajtu odpovědi. */
function timedFetch(base: typeof fetch, candidate: Candidate, now: () => number, onFirstByte: (at: number) => void): typeof fetch {
  return async (input, init) => {
    let body = init?.body;
    if (candidate.body !== undefined && typeof body === 'string') {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      for (const key of candidate.body.omit ?? []) delete parsed[key];
      body = JSON.stringify({ ...parsed, ...candidate.body.set });
    }
    const response = await base(input, { ...init, body });
    if (response.body === null) {
      onFirstByte(now());
      return response;
    }
    let seen = false;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!seen) {
          seen = true;
          onFirstByte(now());
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function hostedConfig(candidate: Candidate, apiKey: string): UpstreamConfig {
  return {
    endpoint: candidate.endpoint, apiKey, model: candidate.model, effort: candidate.effort, pricing: candidate.pricing,
    maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: HOSTED_TIMEOUT_MS, profile: 'api', callCap: null,
  };
}

/** Jedno placené čtení: tělo odpovědi nebo proč žádné, účtenka a útrata (bez účtenky nejhorší případ). */
interface HostedRead { readonly body: unknown; readonly failure: { readonly error: ReadError; readonly detail: string } | null; readonly usage: Usage | null; readonly usd: number }
export interface HostedReader { worstCaseUsd(call: GenerationCall): number; read(call: GenerationCall): Promise<HostedRead> }

function openaiReader(candidate: Candidate, apiKey: string, fetchImpl: typeof fetch): HostedReader {
  const branch = upstreamBranch(hostedConfig(candidate, apiKey), fetchImpl);
  return {
    worstCaseUsd: (call) => branch.worstCaseUsd(call),
    async read(call) {
      const outcome = await branch.generate(call);
      const usd = outcome.usage === null ? branch.worstCaseUsd(call) : costUsd(outcome.usage, candidate.pricing);
      if (outcome.ok) return { body: outcome.body, failure: null, usage: outcome.usage, usd };
      const error = outcome.reason === 'MALFORMED_RESPONSE' ? 'invalid' : outcome.reason === 'UPSTREAM_REJECTED' ? 'rejected' : 'unavailable';
      return { body: undefined, failure: { error, detail: outcome.detail }, usage: outcome.usage, usd };
    },
  };
}

/** Klíče JSON Schema, které structured outputs Anthropicu odmítnou; hlídá je dál `readingSchema` po odpovědi. */
const ANTHROPIC_UNSUPPORTED = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);

/** Schéma čtení bez omezení, která Anthropic nebere; jména vlastností (`properties`) se nefiltrují. */
export function anthropicSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(anthropicSchema);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).flatMap(([key, value]) => {
    if (ANTHROPIC_UNSUPPORTED.has(key)) return [];
    if (key !== 'properties') return [[key, anthropicSchema(value)]];
    return [[key, Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, anthropicSchema(sub)]))]];
  }));
}

/**
 * Anthropic Messages API: týž systémový prompt a schéma (`output_config.format`) jako ostatní, úsilí z kandidáta
 * (Opus 5.5 uvažování vypnout nedovolí, `low` je nejméně). Systémový prompt nese bod cache – je u každé věty stejný,
 * takže od druhého volání se čte z cache, stejně jako OpenAI cachuje sám. Záložní model při odmítnutí (`fallbacks`)
 * se schválně neposílá: odpověď by pak nebyla od měřeného modelu. Odmítnutí nebo useknutí je neplatná odpověď.
 * Klíč vázaný na uživatele (`sk-ant-usr…`) API pustí jen s hlavičkou `anthropic-workspace-id` (`workspaceId`, z
 * `ANTHROPIC_WORKSPACE_ID`); klíč jednoho pracovního prostoru ji nepotřebuje.
 */
export function anthropicReader(candidate: Candidate, apiKey: string, fetchImpl: typeof fetch, workspaceId = ''): HostedReader {
  const { usdPerMTokIn: input, usdPerMTokOut: output } = candidate.pricing;
  const cache = candidate.cache ?? { write: 1, read: 1 };
  // Jeden token na znak jako `upstream.ts`, a celý vstup jako zápis do cache – dražší než čerstvý vstup.
  const worstCaseUsd = (call: GenerationCall) => ((call.request.system.length + call.request.user.length) * input * Math.max(1, cache.write) + MAX_OUTPUT_TOKENS * output) / 1e6;
  // Záporná, chybějící nebo nulová účtenka je nečitelná (jako `usageOf` v `upstream.ts`) a účtuje se nejhorším případem.
  const receipt = (raw: unknown): { usage: Usage; usd: number } | null => {
    const counts = (raw ?? {}) as Record<string, unknown>;
    const [fresh, out, written, cached] = [counts.input_tokens, counts.output_tokens, counts.cache_creation_input_tokens ?? 0, counts.cache_read_input_tokens ?? 0];
    if (typeof fresh !== 'number' || typeof out !== 'number' || typeof written !== 'number' || typeof cached !== 'number') return null;
    if (!(fresh >= 0 && out >= 0 && written >= 0 && cached >= 0) || fresh + out + written + cached === 0) return null;
    return { usage: { inputTokens: fresh + written + cached, outputTokens: out }, usd: ((fresh + written * cache.write + cached * cache.read) * input + out * output) / 1e6 };
  };
  return {
    worstCaseUsd,
    async read(call) {
      const worst = worstCaseUsd(call);
      const fail = (error: ReadError, detail: string, paid: { usage: Usage; usd: number } | null = null): HostedRead => ({ body: undefined, failure: { error, detail }, usage: paid?.usage ?? null, usd: paid?.usd ?? worst });
      let response: Response;
      try {
        response = await fetchImpl(candidate.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(workspaceId === '' ? {} : { 'anthropic-workspace-id': workspaceId }) },
          body: JSON.stringify({
            model: candidate.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            output_config: { effort: candidate.effort, format: { type: 'json_schema', schema: anthropicSchema(call.request.outputSchema) } },
            system: [{ type: 'text', text: call.request.system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: call.request.user }],
          }),
          signal: AbortSignal.timeout(HOSTED_TIMEOUT_MS),
        });
      } catch (thrown) {
        return fail('unavailable', `the Anthropic call did not complete: ${(thrown as Error).message}`);
      }
      if (!response.ok) return fail(response.status >= 500 || response.status === 429 ? 'unavailable' : 'rejected', `Anthropic answered ${response.status}: ${(await response.text()).slice(0, 160)}`);
      let payload: { content?: { type?: unknown; text?: unknown }[]; stop_reason?: unknown; usage?: unknown };
      try {
        payload = (await response.json()) as typeof payload;
      } catch (thrown) {
        return fail('invalid', `the Anthropic answer is not JSON: ${(thrown as Error).message}`);
      }
      const paid = receipt(payload.usage);
      const text = payload.content?.find((block) => block.type === 'text')?.text;
      if (payload.stop_reason !== 'end_turn' || typeof text !== 'string') return fail('invalid', `Anthropic stopped with ${String(payload.stop_reason)}${typeof text === 'string' ? '' : ', no text block'}`, paid);
      try {
        return { body: JSON.parse(text) as unknown, failure: null, usage: paid?.usage ?? null, usd: paid?.usd ?? worst };
      } catch (thrown) {
        return fail('invalid', `the Anthropic text is not JSON: ${(thrown as Error).message}`, paid);
      }
    },
  };
}

const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const sameRole = (label: string | null | undefined, read: string | null): boolean => {
  if (label === undefined) return true;
  if (label === null || read === null) return label === read;
  const [a, b] = [label.toLowerCase().trim(), read.toLowerCase().trim()];
  return a.includes(b) || b.includes(a);
};

export function summaryOf(rows: readonly CompareRow[], sentences: ReadonlyMap<string, SetSentence>, model: string) {
  const reads = rows.flatMap((row) => (row.models[model] === undefined ? [] : [{ row, read: row.models[model]! }]));
  const of = (kind: CompareRow['kind']) => reads.filter(({ row }) => row.kind === kind);
  const roles = reads.filter(({ row }) => sentences.get(`${row.set}#${row.id}`)?.hero !== undefined);
  const totals = reads.map(({ read }) => read.totalMs);
  const firstBytes = reads.flatMap(({ read }) => (read.firstByteMs === null ? [] : [read.firstByteMs]));
  return {
    sentences: reads.length,
    targets: { of: of('target').length, hit: of('target').filter(({ read }) => read.hit === true).length, modeHit: of('target').filter(({ read }) => read.modeHit === true).length },
    traps: { of: of('trap').length, offLure: of('trap').filter(({ read }) => read.hit === true).length },
    roles: {
      of: roles.length,
      hero: roles.filter(({ row, read }) => read.reading !== null && sameRole(sentences.get(`${row.set}#${row.id}`)!.hero, read.reading.hero)).length,
      foe: roles.filter(({ row, read }) => read.reading !== null && sameRole(sentences.get(`${row.set}#${row.id}`)!.foe, read.reading.foe)).length,
    },
    invalid: reads.filter(({ read }) => read.error === 'invalid').length,
    errors: reads.filter(({ read }) => read.error !== null).length,
    latencyMs: { p50: quantile(totals, 0.5), p95: quantile(totals, 0.95), max: totals.length === 0 ? null : Math.max(...totals), overBudget: totals.filter((ms) => ms > BUDGET_MS).length, overGate: totals.filter((ms) => ms > GATE_MS).length },
    firstByteMs: { p50: quantile(firstBytes, 0.5), p95: quantile(firstBytes, 0.95) },
    tokens: { input: reads.reduce((sum, { read }) => sum + (read.inputTokens ?? 0), 0), output: reads.reduce((sum, { read }) => sum + (read.outputTokens ?? 0), 0) },
    usd: Math.round(reads.reduce((sum, { read }) => sum + read.usd, 0) * 1e6) / 1e6,
    listUsd: reads.some(({ read }) => read.listUsd !== null) ? Math.round(reads.reduce((sum, { read }) => sum + (read.listUsd ?? 0), 0) * 1e6) / 1e6 : null,
  };
}

/** Tytéž věty jen se slovníkem (`classifyGenre(věta, null)` – dnešní rychlá hra bez čtečky), zdarma a pro srovnání. */
export function dictionaryOf(rows: readonly CompareRow[], sets: readonly SentenceSet[]) {
  const sentences = new Map(sets.flatMap((set) => set.sentences.map((sentence) => [`${set.name}#${sentence.id}`, sentence] as const)));
  const scored = rows.map((row) => {
    const sentence = sentences.get(`${row.set}#${row.id}`)!;
    const top = classifyGenre(sentence.text, null).ranked[0];
    const classified = top === undefined ? null : `${top.genre}.${top.mode}`;
    return { row, classified, ...scoreOf(sentence, classified) };
  });
  const summary = (of: typeof scored) => ({
    targets: { of: of.filter(({ row }) => row.kind === 'target').length, hit: of.filter(({ row, hit }) => row.kind === 'target' && hit === true).length, modeHit: of.filter(({ row, modeHit }) => row.kind === 'target' && modeHit === true).length },
    traps: { of: of.filter(({ row }) => row.kind === 'trap').length, offLure: of.filter(({ row, hit }) => row.kind === 'trap' && hit === true).length },
  });
  return {
    all: summary(scored),
    perSet: Object.fromEntries(sets.map((set) => [set.name, summary(scored.filter(({ row }) => row.set === set.name))])),
    classified: Object.fromEntries(scored.map(({ row, classified }) => [`${row.set}#${row.id}`, classified])),
  };
}

/** Přečte všechny věty všech sad každým modelem; po stropu útraty skončí a vrátí, co stihl. */
export async function compareReaders(options: { readonly models: readonly Candidate[]; readonly sets: readonly SentenceSet[]; readonly capUsd: number }, deps: CompareDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? (() => undefined);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const runClaude = deps.runClaude ?? runClaudeCli;
  if (!(options.capUsd >= 0)) throw new Error('--cap-usd must be a number ≥ 0');
  const keys = new Map<string, string>();
  for (const model of options.models) {
    if (model.keyEnv === null) continue;
    const key = (env[model.keyEnv] ?? '').trim();
    if (key === '') throw new Error(`${model.id} needs ${model.keyEnv} (in .env.local)`);
    keys.set(model.id, key);
  }
  const system = readerSystemPrompt();
  const rows: CompareRow[] = [];
  const sentences = new Map<string, SetSentence>();
  let spentUsd = 0;
  let stopped: { by: 'cap'; set: string; id: string; model: string } | null = null;

  outer: for (const set of options.sets) {
    for (const sentence of set.sentences) {
      sentences.set(`${set.name}#${sentence.id}`, sentence);
      const row: CompareRow = { set: set.name, id: sentence.id, kind: kindOf(sentence), label: fullMode(sentence.genre), lure: fullMode(sentence.lure), models: {} };
      for (const model of options.models) {
        const call: GenerationCall = { prompt: sentence.text, request: { model: model.model, system, user: sentence.text, outputSchema: READING_JSON_SCHEMA } };
        let firstByteAt: number | null = null;
        const timed = timedFetch(fetchImpl, model, now, (at) => { firstByteAt ??= at; });
        const reader = model.kind === 'openai' ? openaiReader(model, keys.get(model.id)!, timed)
          : model.kind === 'anthropic' ? anthropicReader(model, keys.get(model.id)!, timed, (env.ANTHROPIC_WORKSPACE_ID ?? '').trim()) : null;
        const worstUsd = reader === null ? 0 : reader.worstCaseUsd(call);
        if (spentUsd + worstUsd > options.capUsd) {
          stopped = { by: 'cap', set: set.name, id: sentence.id, model: model.id };
          if (Object.keys(row.models).length > 0) rows.push(row);
          break outer;
        }
        const started = now();
        let body: unknown;
        let failure: { error: ReadError; detail: string } | null = null;
        let usage: Usage | null = null;
        let usd = 0;
        let listUsd: number | null = null;
        if (reader !== null) {
          ({ body, failure, usage, usd } = await reader.read(call));
        } else {
          const outcome = await runClaude({ model: model.model, system, user: sentence.text, schema: READING_JSON_SCHEMA, timeoutMs: CLAUDE_TIMEOUT_MS });
          listUsd = outcome.listUsd;
          if (outcome.ok) {
            body = outcome.body;
            usage = outcome.usage;
            if (outcome.firstByteMs !== null) firstByteAt = started + outcome.firstByteMs;
          } else failure = { error: 'unavailable', detail: outcome.detail };
        }
        const totalMs = Math.round(now() - started);
        spentUsd += usd;
        const parsed = failure === null ? readingSchema.safeParse(body) : null;
        if (parsed !== null && !parsed.success) failure = { error: 'invalid', detail: parsed.error.issues[0]?.message ?? 'the answer breaks the reading schema' };
        const reading = parsed?.success === true ? parsed.data : null;
        const top = reading === null ? undefined : classifyGenre(sentence.text, reading).ranked[0];
        const classified = top === undefined ? null : `${top.genre}.${top.mode}`;
        const score = scoreOf(sentence, classified);
        row.models[model.id] = {
          error: failure?.error ?? null, detail: failure?.detail.slice(0, 200) ?? null, reading,
          readGenre: reading?.genre == null ? null : `${reading.genre.genre}.${reading.genre.mode}`,
          classified, hit: score.hit, modeHit: score.modeHit,
          firstByteMs: firstByteAt === null ? null : Math.round(firstByteAt - started), totalMs,
          inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, usd, listUsd,
        };
      }
      rows.push(row);
      log(`${set.name}/${sentence.id} ${options.models.map((model) => `${model.id}=${row.models[model.id]?.error ?? row.models[model.id]?.classified ?? '-'} ${row.models[model.id]?.totalMs ?? '-'}ms`).join('  ')}`);
    }
  }

  const summary = Object.fromEntries(options.models.map((model) => [model.id, {
    all: summaryOf(rows, sentences, model.id),
    perSet: Object.fromEntries(options.sets.map((set) => [set.name, summaryOf(rows.filter((row) => row.set === set.name), sentences, model.id)])),
  }]));
  return { capUsd: options.capUsd, spentUsd: Math.round(spentUsd * 1e6) / 1e6, stopped, summary, rows };
}

/** `claude.cmd` jen volá `claude.exe` vedle sebe; ten jde spustit přímo, bez shellu, který by rozsekal argumenty. */
const CLAUDE_EXE = process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude';

/** `claude -p` v prázdném adresáři, bez nástrojů, CLAUDE.md a hooků (`--safe-mode`); věta jde stdinem. */
export const runClaudeCli: ClaudeRunner = ({ model, system, user, schema, timeoutMs }) => new Promise((done) => {
  const cwd = mkdtempSync(join(tmpdir(), 'p58b-reader-'));
  const args = ['-p', '--safe-mode', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt', system];
  const { ANTHROPIC_API_KEY: _paid, ...childEnv } = process.env;
  const started = performance.now();
  const child = spawn(CLAUDE_EXE, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let firstByteMs: number | null = null;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    firstByteMs ??= Math.round(performance.now() - started);
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.on('error', (error) => { stderr += error.message; });
  child.stdin.end(user);
  child.on('close', (code) => {
    clearTimeout(timer);
    let envelope: { is_error?: boolean; structured_output?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; total_cost_usd?: number } | undefined;
    try {
      envelope = JSON.parse(stdout) as typeof envelope;
    } catch {
      envelope = undefined;
    }
    const listUsd = typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null;
    if (code !== 0 || envelope === undefined || envelope.is_error === true || envelope.structured_output === undefined) {
      done({ ok: false, detail: `claude -p exit ${String(code)}: ${(stderr || stdout).trim().slice(-200)}`, listUsd });
      return;
    }
    // `input_tokens` je jen nekešovaný zbytek; vstup celý = i zápis a čtení cache (smoke 23. 10.: 2 tokeny místo ~6 000).
    const { input_tokens: fresh, output_tokens: output, cache_creation_input_tokens: written = 0, cache_read_input_tokens: cached = 0 } = envelope.usage ?? {};
    const usage = typeof fresh === 'number' && typeof output === 'number' ? { inputTokens: fresh + written + cached, outputTokens: output } : null;
    done({ ok: true, body: envelope.structured_output, usage, listUsd, firstByteMs });
  });
});

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const models = arg('models')?.split(',').map((id) => id.trim()).filter((id) => id !== '');
  const setPaths = arg('set')?.split(',').map((path) => path.trim()).filter((path) => path !== '');
  const cap = arg('cap-usd');
  if (models === undefined || models.length === 0 || setPaths === undefined || setPaths.length === 0 || cap === undefined) {
    console.error(`usage: compare.measure.ts --models <${Object.keys(CANDIDATES).join('|')},…> --set <file.json,…> --cap-usd <n> [--out <file>]`);
    process.exit(2);
  }
  const unknown = models.filter((id) => CANDIDATES[id] === undefined);
  if (unknown.length > 0) {
    console.error(`unknown model ${unknown.join(', ')}; known: ${Object.keys(CANDIDATES).join(', ')}`);
    process.exit(2);
  }
  let sets: SentenceSet[];
  let result: Awaited<ReturnType<typeof compareReaders>>;
  try {
    sets = setPaths.map(loadSet);
    result = await compareReaders({ models: models.map((id) => CANDIDATES[id]!), sets, capUsd: Number(cap) }, { log: console.log });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const out = resolve(ROOT, arg('out') ?? join('evals', 'play', 'p58b', `compare-${sets.map((set) => set.name.replace('/', '-')).join('+')}.json`));
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dictionary = dictionaryOf(result.rows, sets);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    schema: 'p58b-compare.v1',
    commit,
    measuredAt: new Date().toISOString(),
    from: 'local PC -> provider',
    promptVersion: readerPromptVersion(),
    sets: setPaths.map((path) => relative(ROOT, resolve(ROOT, path)).replaceAll('\\', '/')),
    models: models.map((id) => {
      const { id: _id, keyEnv: _key, ...rest } = CANDIDATES[id]!;
      return { id, ...rest, endpoint: rest.endpoint === '' ? 'claude -p' : new URL(rest.endpoint.replace(/^openai:/, '')).host };
    }),
    ...result,
    dictionary,
  }, null, 1)}\n`);
  console.log(`dictionary only: targets ${dictionary.all.targets.hit}/${dictionary.all.targets.of}, traps ${dictionary.all.traps.offLure}/${dictionary.all.traps.of}`);
  for (const id of models) {
    const all = result.summary[id]!.all;
    console.log(`${id}: targets ${all.targets.hit}/${all.targets.of}, traps ${all.traps.offLure}/${all.traps.of}, invalid ${all.invalid}, errors ${all.errors}, p50 ${all.latencyMs.p50} ms, p95 ${all.latencyMs.p95} ms, ${all.usd} USD${all.listUsd === null ? '' : ` (list ${all.listUsd} USD)`}`);
  }
  console.log(`spent ${result.spentUsd}/${result.capUsd} USD${result.stopped === null ? '' : ` – stopped by the cap at ${result.stopped.set}/${result.stopped.id} (${result.stopped.model})`} -> ${relative(ROOT, out)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
