/**
 * Hlas vypravěče (P29D T11): cíl hry přečtený lokálním Kokoro-82M
 * (`ops/audio/server.py`, port 8794, za tunelem).
 *
 * Publikace založí úlohu a nečeká na ni (`scheduleVoice`) – hra se publikuje
 * stejně rychle a bez služby úplně stejně. Hra si nahrávku vyžádá až po
 * prvním gestu přes `GET …/:id/voice` (`fetchVoice`); dokud není hotová,
 * dveře vrátí 204 a hra mlčí. Klíč `PLAY_VOICE_KEY` zůstává na serveru.
 *
 * Id nahrávky je hash hlasu a textu, stejně jako `voice_id` v `ops/audio/voice.py`
 * – Next tak adresu zná bez paměti mezi publikací a přehráním.
 *
 * Demo bez domácího PC (P30A T5) mluví přes hostované OpenAI `/audio/speech`
 * (`PLAY_VOICE_ENDPOINT=openai-speech:<kořen>`, `PLAY_VOICE_MODEL`, klíč jako
 * bearer token). Tam cache drží Next sám: hotová nahrávka jde pod id textu
 * do téhož úložiště jako cache her, takže každý cíl se platí jednou.
 */

import { createHash } from 'node:crypto';

import { after } from 'next/server';

import type { GameSpecV1 } from '@/play/spec';
import { ANSWER_CACHE_TIMEOUT_MS, ANSWER_TTL_SECONDS, type AnswerStore, httpAnswerStore, processAnswerStore } from '@/server/answer-cache';
import { isServerless, sharedStoreFromEnv, storePrefix } from '@/server/spend-store';

export const VOICE = 'af_heart';
const MAX_CHARS = 240;
const TIMEOUT_MS = 3_000;
const HOSTED = 'openai-speech:';
/** Hostovaná syntéza běží v `after()`, nikoho nedrží; 240 znaků trvá u poskytovatele kolem sekundy. */
const SPEECH_TIMEOUT_MS = 15_000;
/** 240 znaků v Opusu je pod 100 kB; víc je cizí odpověď, ne nahrávka, a do úložiště nepatří. */
const MAX_AUDIO_BYTES = 512 * 1024;
/** Jedno placené volání na text za tuto dobu, i když skončí chybou (viz `synthesizeVoice`). */
const RETRY_AFTER_SECONDS = 60;

export interface VoiceEndpoint {
  readonly url: string;
  readonly key: string;
  /** Jen hostované OpenAI `/audio/speech`; místní služba model nemá. */
  readonly model?: string;
}

type Env = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;

/**
 * Služba z `PLAY_VOICE_ENDPOINT` + `PLAY_VOICE_KEY` (hostované API navíc `PLAY_VOICE_MODEL`);
 * chybí-li něco, nebo adresa není http(s), hlas je vypnutý.
 */
export function voiceEndpointFrom(env: Env = process.env): VoiceEndpoint | null {
  const raw = env.PLAY_VOICE_ENDPOINT?.trim() ?? '';
  const hosted = raw.startsWith(HOSTED);
  const url = hosted ? raw.slice(HOSTED.length) : raw;
  const key = env.PLAY_VOICE_KEY?.trim() ?? '';
  const model = env.PLAY_VOICE_MODEL?.trim() ?? '';
  if (url === '' || key === '' || (hosted && model === '')) return null;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const root = url.replace(/\/+$/, '');
  return hosted ? { url: root, key, model } : { url: root, key };
}

/**
 * Věta k přečtení – totéž čištění jako `narration` ve `voice.py`; `null` = není co číst.
 * Jen ASCII, ne `\s` ani `trim()`: ty berou za mezeru jiné znaky Unicode než Python.
 */
export function narrationOf(spec: GameSpecV1): string | null {
  // eslint-disable-next-line no-control-regex -- řídicí znaky se nahrazují mezerou jako v Pythonu
  const text = spec.tutorial.goalLine.replace(/[\x00-\x20\x7f]+/g, ' ').replace(/^ | $/g, '');
  return text === '' || text.length > MAX_CHARS ? null : text;
}

export function voiceIdOf(text: string): string {
  return createHash('sha256').update(`${VOICE}\n${text}`, 'utf8').digest('hex').slice(0, 32);
}

/** Založí úlohu ve službě; chyba (služba spí, tunel spadl) se jen zaznamená – hra zůstane bez hlasu. */
export async function requestVoice(text: string, endpoint: VoiceEndpoint, fetchImpl: Fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${endpoint.url}/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-audio-key': endpoint.key },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`[play] voice job refused: ${String(response.status)}`);
    return response.ok;
  } catch (error) {
    console.warn(`[play] voice service unreachable: ${error instanceof Error ? error.name : 'error'}`);
    return false;
  }
}

/**
 * Cache hlasu hostovaného API: sdílené úložiště jako u cache her. Bez něj jen
 * mimo serverless paměť procesu – na Vercelu by každá instance platila znovu,
 * takže tam hostovaný hlas bez úložiště mlčí (`null`).
 */
function voiceStore(env: Env, fetchImpl: Fetch): AnswerStore | null {
  const shared = sharedStoreFromEnv(env);
  if (shared === null) return isServerless(env) ? null : processAnswerStore();
  return httpAnswerStore({ url: shared.url, token: shared.token, prefix: storePrefix(env), timeoutMs: ANSWER_CACHE_TIMEOUT_MS }, fetchImpl);
}

const voiceKey = (text: string): string => `voice:${voiceIdOf(text)}`;
const pendingKey = (text: string): string => `${voiceKey(text)}:pending`;

const isOgg = (audio: Uint8Array): boolean => audio.length > 4 && audio.length <= MAX_AUDIO_BYTES && String.fromCharCode(...audio.subarray(0, 4)) === 'OggS';

/**
 * Nahrávka z hostovaného API do cache hlasu. Hotovou nečte znovu; úložiště,
 * které neodpoví, znamená nic neplatit – výsledek by nebylo kam uložit.
 * Před placením jde do úložiště značka na `RETRY_AFTER_SECONDS`: souběžné
 * GET ani GET po selhaném volání (poskytovatel účtoval, ale nahrávka se
 * neuložila) do té doby neplatí znovu.
 */
async function synthesizeVoice(text: string, endpoint: VoiceEndpoint, store: AnswerStore, fetchImpl: Fetch): Promise<boolean> {
  try {
    if ((await store.get(voiceKey(text))) !== null) return true;
    if ((await store.get(pendingKey(text))) !== null) return false;
    await store.set(pendingKey(text), '1', RETRY_AFTER_SECONDS);
    const response = await fetchImpl(`${endpoint.url}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.key}` },
      body: JSON.stringify({ model: endpoint.model, input: text, voice: VOICE, response_format: 'opus' }),
      signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[play] speech API refused: ${String(response.status)}`);
      return false;
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (!isOgg(audio)) {
      console.warn('[play] speech API answered something that is not an Ogg recording');
      return false;
    }
    await store.set(voiceKey(text), Buffer.from(audio).toString('base64'), ANSWER_TTL_SECONDS);
    return true;
  } catch (error) {
    console.warn(`[play] speech API or voice cache unreachable: ${error instanceof Error ? error.name : 'error'}`);
    return false;
  }
}

/**
 * Neblokující úloha po publikaci. `after()` jako u remixu: na serverless se
 * instance po odpovědi zmrazí. Mimo požadavek (testy, úloha v `after`) běží volně.
 */
export function scheduleVoice(spec: GameSpecV1, env: Env = process.env, fetchImpl: Fetch = fetch): boolean {
  const endpoint = voiceEndpointFrom(env);
  const text = narrationOf(spec);
  if (endpoint === null || text === null) return false;
  let task: Promise<boolean>;
  if (endpoint.model === undefined) task = requestVoice(text, endpoint, fetchImpl);
  else {
    const store = voiceStore(env, fetchImpl);
    if (store === null) return false;
    task = synthesizeVoice(text, endpoint, store, fetchImpl);
  }
  try {
    after(task);
  } catch {
    void task;
  }
  return true;
}

/** Hotová nahrávka cíle (Ogg), nebo `null` – služba chybí, spí, nebo ještě generuje. */
export async function fetchVoice(spec: GameSpecV1, env: Env = process.env, fetchImpl: Fetch = fetch): Promise<Uint8Array<ArrayBuffer> | null> {
  const endpoint = voiceEndpointFrom(env);
  const text = narrationOf(spec);
  if (endpoint === null || text === null) return null;
  if (endpoint.model !== undefined) {
    const store = voiceStore(env, fetchImpl);
    if (store === null) return null;
    try {
      const stored = await store.get(voiceKey(text));
      return stored === null ? null : new Uint8Array(Buffer.from(stored, 'base64'));
    } catch {
      return null;
    }
  }
  try {
    const response = await fetchImpl(`${endpoint.url}/voice/${voiceIdOf(text)}`, {
      headers: { 'x-audio-key': endpoint.key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('audio/ogg')) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}
