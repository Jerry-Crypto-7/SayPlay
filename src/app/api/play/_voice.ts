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
 */

import { createHash } from 'node:crypto';

import { after } from 'next/server';

import type { GameSpecV1 } from '@/play/spec';

export const VOICE = 'af_heart';
const MAX_CHARS = 240;
const TIMEOUT_MS = 3_000;

export interface VoiceEndpoint {
  readonly url: string;
  readonly key: string;
}

type Env = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;

/** Služba z `PLAY_VOICE_ENDPOINT` + `PLAY_VOICE_KEY`; chybí-li jedno, nebo adresa není http(s), hlas je vypnutý. */
export function voiceEndpointFrom(env: Env = process.env): VoiceEndpoint | null {
  const url = env.PLAY_VOICE_ENDPOINT?.trim() ?? '';
  const key = env.PLAY_VOICE_KEY?.trim() ?? '';
  if (url === '' || key === '') return null;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { url: url.replace(/\/+$/, ''), key };
}

/** Věta k přečtení – totéž čištění jako `narration` ve `voice.py`; `null` = není co číst. */
export function narrationOf(spec: GameSpecV1): string | null {
  // eslint-disable-next-line no-control-regex -- řídicí znaky se nahrazují mezerou jako v Pythonu
  const text = spec.tutorial.goalLine.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
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
 * Neblokující úloha po publikaci. `after()` jako u remixu: na serverless se
 * instance po odpovědi zmrazí. Mimo požadavek (testy, úloha v `after`) běží volně.
 */
export function scheduleVoice(spec: GameSpecV1, env: Env = process.env, fetchImpl: Fetch = fetch): boolean {
  const endpoint = voiceEndpointFrom(env);
  const text = narrationOf(spec);
  if (endpoint === null || text === null) return false;
  const task = requestVoice(text, endpoint, fetchImpl);
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
