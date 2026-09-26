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

export async function readSentence(text: string, { endpoint, timeoutMs }: ReadOptions): Promise<Reading | null> {
  if (process.env.PLAY_READER === 'off' || endpoint === '') return null;
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
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
  }
}
