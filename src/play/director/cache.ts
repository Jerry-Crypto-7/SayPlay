/**
 * Cache přijatých GameSpec (P23-B T7). `CachedAnswer` z `answer-cache.ts` má
 * tvar `planner/compiler` a sem se nehodí; použije se jen port `AnswerStore`
 * (klíč → text) a přes něj tenká cache: záznam je JSON specu, čte se zpět
 * přes `readGameSpec`, takže rozbitý nebo zastaralý záznam je miss a nikdy
 * výjimka. Zapisuje se **jen přijatý** spec – návrh ani neopravená odpověď
 * modelu do cache nepatří, jinak by se výpadek modelu zapekl na sedm dní.
 *
 * Klíč: `sha256(normalizeSentence(sentence) \n DIRECTOR_PROMPT_VERSION \n
 * model \n endpoint)` – změna registru nebo pravidel hne verzí promptu a tím
 * i klíčem.
 */

import { createHash } from 'node:crypto';

import { ANSWER_CACHE_TIMEOUT_MS, ANSWER_TTL_SECONDS, type AnswerStore, httpAnswerStore, memoryAnswerStore, normalizeSentence } from '@/server/answer-cache';
import { sharedStoreFromEnv, storePrefix } from '@/server/spend-store';

import { readGameSpec, type GameSpecV1 } from '../spec';

export interface DirectorKeyInput {
  readonly sentence: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly endpoint: string;
}

export function directorKey(input: DirectorKeyInput): string {
  return createHash('sha256').update([normalizeSentence(input.sentence), input.promptVersion, input.model, input.endpoint].join('\n')).digest('hex');
}

export interface DirectorCache {
  readonly id: string;
  read(key: string): Promise<GameSpecV1 | null>;
  write(key: string, spec: GameSpecV1): Promise<void>;
}

export function directorCache(store: AnswerStore, log: (line: string) => void = (line) => console.warn(`[play] ${line}`)): DirectorCache {
  return {
    id: store.id,
    async read(key) {
      let raw: string | null;
      try {
        raw = await store.get(key);
      } catch (thrown) {
        log(`the director cache could not be read; treating it as a miss: ${String(thrown)}`);
        return null;
      }
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log('the director cache holds a record this server cannot read; treating it as a miss');
        return null;
      }
      const result = readGameSpec(parsed);
      if (!result.ok) {
        log(`the director cache holds a spec this server rejects (${result.reason}); treating it as a miss`);
        return null;
      }
      return result.value;
    },
    async write(key, spec) {
      try {
        await store.set(key, JSON.stringify(spec), ANSWER_TTL_SECONDS);
      } catch (thrown) {
        log(`the director cache could not be written: ${String(thrown)}`);
      }
    },
  };
}

/** Sdílené úložiště podle prostředí (stejně jako kniha stropu), jinak paměť procesu. */
export function directorCacheFromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): DirectorCache {
  const shared = sharedStoreFromEnv(env);
  const store =
    shared === null
      ? memoryAnswerStore()
      : httpAnswerStore({ url: shared.url, token: shared.token, prefix: storePrefix(env), timeoutMs: ANSWER_CACHE_TIMEOUT_MS }, fetchImpl);
  return directorCache(store);
}
