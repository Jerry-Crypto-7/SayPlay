/**
 * Hlas vypravěče přes hostované OpenAI `/audio/speech` (P30A T5): demo mluví
 * bez domácího PC. Publikace nahrávku objedná a nečeká, hotovou uloží do cache
 * hlasu a dveře ji pak vydají bez dalšího placeného volání. Bez klíče nebo při
 * chybě hra mlčí.
 *
 * Poskytovatel je atrapa `fetch`; publikace, úložiště i dveře jsou skutečné.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { resetProcessAnswerStore } from '@/server/answer-cache';
import { resetRateWindows } from '@/server/rate-limit';

import runnerFixture from '@/play/arcade/__fixtures__/runner.json';

import { readGameSpec } from '@/play/spec';

import { fetchVoice, scheduleVoice, voiceEndpointFrom } from '../_voice';
import { POST as createGame } from '../games/route';
import { GET as voiceOf } from '../games/[id]/voice/route';

const CALLER = { 'x-forwarded-for': '203.0.113.9' };
const API = 'https://api.deepinfra.com/v1/openai';
const MODEL = 'hexgrad/Kokoro-82M';
const KEY = 'speech-test-key';
const GOAL = runnerFixture.tutorial.goalLine;
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 9, 7]);

type Call = { url: string; init: RequestInit | undefined };
type Answer = 'ogg' | 'hang' | 'down' | 'error' | 'page';

/** Atrapa poskytovatele: `POST /audio/speech` vrátí Ogg, visí, spadne, odpoví 500 nebo cizí stránkou. */
function provider(answer: Answer = 'ogg') {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (!url.startsWith(API)) throw new Error(`unexpected fetch ${url}`);
      if (answer === 'hang') return new Promise<Response>(() => {});
      if (answer === 'down') throw new TypeError('fetch failed');
      if (answer === 'error') return new Response('overloaded', { status: 500 });
      if (answer === 'page') return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      return new Response(OGG, { headers: { 'content-type': 'audio/ogg' } });
    }),
  );
  return calls;
}

const speechPosts = (calls: readonly Call[]) => calls.filter((call) => call.url === `${API}/audio/speech`);
/** Úloha běží mimo požadavek (`after()` v testu nejde); nech ji doběhnout. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function publish(title: string): Promise<string> {
  const created = await createGame(
    new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CALLER },
      body: JSON.stringify({ spec: { ...runnerFixture, title } }),
    }),
  );
  const text = await created.text();
  expect(created.status, text).toBeLessThan(300);
  return (JSON.parse(text) as { versionId: string }).versionId;
}

function voice(id: string): Promise<Response> {
  return voiceOf(new Request(`http://play.test/api/play/games/${id}/voice`, { headers: CALLER }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetProcessAnswerStore();
  resetRateWindows();
  vi.stubEnv('PLAY_VOICE_ENDPOINT', `openai-speech:${API}/`);
  vi.stubEnv('PLAY_VOICE_MODEL', MODEL);
  vi.stubEnv('PLAY_VOICE_KEY', KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('hosted speech endpoint', () => {
  it('needs the openai-speech address, the model and the key', () => {
    const env = { PLAY_VOICE_ENDPOINT: `openai-speech:${API}/`, PLAY_VOICE_MODEL: MODEL, PLAY_VOICE_KEY: KEY };
    expect(voiceEndpointFrom(env)).toEqual({ url: API, key: KEY, model: MODEL });
    expect(voiceEndpointFrom({ ...env, PLAY_VOICE_MODEL: ' ' })).toBeNull();
    expect(voiceEndpointFrom({ ...env, PLAY_VOICE_KEY: '' })).toBeNull();
    expect(voiceEndpointFrom({ ...env, PLAY_VOICE_ENDPOINT: 'openai-speech:file:///etc/passwd' })).toBeNull();
    // Místní služba model nemá ani nepotřebuje.
    expect(voiceEndpointFrom({ ...env, PLAY_VOICE_ENDPOINT: 'http://127.0.0.1:8794' })).toEqual({ url: 'http://127.0.0.1:8794', key: KEY });
  });
});

describe('voice through the hosted speech API', () => {
  it('publishing asks /audio/speech once for the goal in af_heart as opus, with the key as a bearer token', async () => {
    const calls = provider();
    await publish('Hosted voice');
    await settle();
    const posts = speechPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.init!.method).toBe('POST');
    expect(JSON.parse(String(posts[0]!.init!.body))).toEqual({ model: MODEL, input: GOAL, voice: 'af_heart', response_format: 'opus' });
    const headers = new Headers(posts[0]!.init!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('x-audio-key')).toBeNull();
  });

  it('the finished voice comes from the voice cache: Ogg, immutable, no second paid call', async () => {
    const calls = provider();
    const id = await publish('Hosted cached');
    await settle();
    for (let round = 0; round < 2; round += 1) {
      const response = await voice(id);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('audio/ogg');
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(OGG);
    }
    await publish('Hosted cached');
    await settle();
    expect(speechPosts(calls)).toHaveLength(1);
  });

  it('a provider that hangs holds neither the publication nor buys a second call from waiting players', async () => {
    const calls = provider('hang');
    const id = await publish('Hosted hang');
    const answers = await Promise.all([voice(id), voice(id), voice(id)]);
    expect(answers.map((response) => response.status)).toEqual([204, 204, 204]);
    await settle();
    expect(speechPosts(calls)).toHaveLength(1);
  });

  it('a failure, a foreign page or a dead network is silence, caches nothing and is paid for at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const answer of ['error', 'page', 'down'] as const) {
      resetProcessAnswerStore();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const calls = provider(answer);
      const id = await publish(`Hosted ${answer}`);
      await settle();
      for (let round = 0; round < 3; round += 1) {
        const response = await voice(id);
        expect(response.status, answer).toBe(204);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      await settle();
      // Poskytovatel mohl účtovat i za neuloženou nahrávku: opakované GET neplatí znovu.
      expect(speechPosts(calls), answer).toHaveLength(1);
      // Nic se nezapeklo: po minutě dveře zkusí znovu a nahrávku dostanou.
      vi.setSystemTime(Date.now() + 61_000);
      const retry = provider('ogg');
      expect((await voice(id)).status, answer).toBe(204);
      await settle();
      expect(speechPosts(retry), answer).toHaveLength(1);
      expect((await voice(id)).status, answer).toBe(200);
      warn.mockRestore();
    }
  });

  it('on Vercel without a shared store it stays silent instead of paying once per instance', async () => {
    const calls = provider();
    const spec = readGameSpec(runnerFixture);
    if (!spec.ok) throw new Error('fixture');
    const env = { PLAY_VOICE_ENDPOINT: `openai-speech:${API}`, PLAY_VOICE_MODEL: MODEL, PLAY_VOICE_KEY: KEY, VERCEL: '1' };
    expect(scheduleVoice(spec.value, env)).toBe(false);
    expect(await fetchVoice(spec.value, env)).toBeNull();
    expect(calls).toHaveLength(0);
    // Mimo Vercel stačí paměť procesu.
    expect(scheduleVoice(spec.value, { ...env, VERCEL: undefined })).toBe(true);
  });

  it('without the key or the model nothing is called and the game is silent', async () => {
    for (const unset of ['PLAY_VOICE_KEY', 'PLAY_VOICE_MODEL'] as const) {
      vi.stubEnv(unset, '');
      const calls = provider();
      const id = await publish(`Hosted without ${unset}`);
      await settle();
      expect((await voice(id)).status).toBe(204);
      expect(calls).toHaveLength(0);
      vi.stubEnv(unset, unset === 'PLAY_VOICE_KEY' ? KEY : MODEL);
    }
  });
});
