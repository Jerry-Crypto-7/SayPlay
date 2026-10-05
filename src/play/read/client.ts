/**
 * Klient lokální čtečky (P29B T2): llama.cpp `llama-server`, OpenAI chat API,
 * odpověď pod gramatikou z `READING_JSON_SCHEMA`.
 *
 * Běží bez dozoru na každé větě, proto nikdy nehází: timeout, chyba sítě,
 * HTTP chyba, nečitelný JSON i porušený kontrakt vrací `null` a draft pak
 * čte větu klíčovými slovy jako dřív. `PLAY_READER=off` čtečku vypne úplně.
 */

import { readerSystemPrompt } from './prompt';
import { READING_JSON_SCHEMA, readingSchema, type Reading } from './schema';

export interface ReadOptions {
  /** Kořen serveru, např. `http://127.0.0.1:8791`; prázdný = čtečka není. */
  readonly endpoint: string;
  readonly timeoutMs: number;
}

/** Rozpočet čtení před draftem, když `PLAY_READER_BUDGET_MS` chybí nebo nedává smysl: strop p95 z pravidla T3. */
export const DEFAULT_READER_BUDGET_MS = 1500;

/**
 * Čtení před draftem (P29B T5) je zapnuté jen `PLAY_READER=on` s endpointem:
 * T3 naměřil čtečku pod klíčovými slovy a rozhodl `off` (`evals/play/read/README.md`).
 */
export function readerEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.PLAY_READER === 'on' && (env.PLAY_READER_ENDPOINT ?? '') !== '';
}

function readerBudgetMs(env: Readonly<Record<string, string | undefined>>): number {
  const budget = Number(env.PLAY_READER_BUDGET_MS);
  return Number.isInteger(budget) && budget > 0 && budget <= 10_000 ? budget : DEFAULT_READER_BUDGET_MS;
}

/** Čtení věty pro draft route a režiséra; vypnutá čtečka = `null` bez volání. */
export async function readBeforeDraft(text: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Reading | null> {
  if (!readerEnabled(env)) return null;
  return readSentence(text, { endpoint: env.PLAY_READER_ENDPOINT!, timeoutMs: readerBudgetMs(env) });
}

export async function readSentence(text: string, { endpoint, timeoutMs }: ReadOptions): Promise<Reading | null> {
  if (process.env.PLAY_READER === 'off' || endpoint === '') return null;
  // `setTimeout`, ne `AbortSignal.timeout`: rozpočet pak drží i falešné hodiny testu.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          { role: 'system', content: readerSystemPrompt() },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_schema', json_schema: { name: 'reading', strict: true, schema: READING_JSON_SCHEMA } },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const parsed = readingSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
