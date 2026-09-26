/**
 * Hlas vypravěče (P29D T11) běží bez dozoru a nese klíč: publikace úlohu
 * založí a nečeká na ni, bez služby je publikace stejná, klíč jde jen do
 * služby a hra dostane nahrávku jen hotovou – jinak 204 a mlčí.
 *
 * Služba je atrapa `fetch`; publikace, úložiště i dveře jsou skutečné.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import runnerFixture from '@/play/arcade/__fixtures__/runner.json';

import { narrationOf, requestVoice, scheduleVoice, voiceEndpointFrom, voiceIdOf } from '../_voice';
import { POST as createGame } from '../games/route';
import { GET as voiceOf } from '../games/[id]/voice/route';
import { readGameSpec } from '@/play/spec';

const CALLER = { 'x-forwarded-for': '203.0.113.9' };
const SERVICE = 'http://127.0.0.1:8794';
const KEY = 'voice-test-key';
const GOAL = runnerFixture.tutorial.goalLine;
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);

type Call = { url: string; init: RequestInit | undefined };

/** Atrapa služby: `POST /voice` odpoví nebo visí, `GET /voice/:id` vrátí Ogg / 202 / chybu sítě. */
function service(answer: { post?: 'ok' | 'hang' | 'down'; get?: 'ogg' | 'pending' | 'broken' | 'down' } = {}) {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (!url.startsWith(SERVICE)) throw new Error(`unexpected fetch ${url}`);
    if (init?.method === 'POST') {
      if (answer.post === 'hang') return new Promise<Response>(() => {});
      if (answer.post === 'down') throw new TypeError('fetch failed');
      return Response.json({ id: 'x', status: 'queued' });
    }
    if (answer.get === 'down') throw new TypeError('fetch failed');
    if (answer.get === 'pending') return Response.json({ status: 'running' }, { status: 202 });
    // Tunel nebo proxy, která chybu vrátí s typem zvuku – tělo není nahrávka.
    if (answer.get === 'broken') return new Response(OGG, { status: 502, headers: { 'content-type': 'audio/ogg' } });
    return new Response(OGG, { headers: { 'content-type': 'audio/ogg' } });
  });
  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

async function publish(title: string): Promise<{ status: number; id: string }> {
  const created = await createGame(
    new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CALLER },
      body: JSON.stringify({ spec: { ...runnerFixture, title } }),
    }),
  );
  expect(created.status, await created.clone().text()).toBeLessThan(300);
  return { status: created.status, id: ((await created.json()) as { versionId: string }).versionId };
}

function voice(id: string): Promise<Response> {
  return voiceOf(new Request(`http://play.test/api/play/games/${id}/voice`, { headers: CALLER }), { params: Promise.resolve({ id }) });
}

const voicePosts = (calls: readonly Call[]) => calls.filter((call) => call.init?.method === 'POST' && call.url === `${SERVICE}/voice`);

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.stubEnv('PLAY_VOICE_ENDPOINT', `${SERVICE}/`);
  vi.stubEnv('PLAY_VOICE_KEY', KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('voice endpoint', () => {
  it('needs both the address and the key, over http(s)', () => {
    expect(voiceEndpointFrom({ PLAY_VOICE_ENDPOINT: `${SERVICE}/`, PLAY_VOICE_KEY: KEY })).toEqual({ url: SERVICE, key: KEY });
    expect(voiceEndpointFrom({ PLAY_VOICE_ENDPOINT: SERVICE })).toBeNull();
    expect(voiceEndpointFrom({ PLAY_VOICE_KEY: KEY })).toBeNull();
    expect(voiceEndpointFrom({ PLAY_VOICE_ENDPOINT: ' ', PLAY_VOICE_KEY: KEY })).toBeNull();
    expect(voiceEndpointFrom({ PLAY_VOICE_ENDPOINT: 'file:///etc/passwd', PLAY_VOICE_KEY: KEY })).toBeNull();
    expect(voiceEndpointFrom({ PLAY_VOICE_ENDPOINT: 'not a url', PLAY_VOICE_KEY: KEY })).toBeNull();
  });

  it('hashes the text exactly like ops/audio/voice.py', () => {
    // Týž řetězec pinuje `ops/audio/tests/test_server.py::test_voice_id_matches_the_next_side`.
    expect(voiceIdOf('Reach the flag before the time runs out.')).toBe('ce7085647d35e2245d58872bf1e061bc');
  });

  it('reads the goal line cleaned, and nothing when it is empty or too long', () => {
    const spec = readGameSpec(runnerFixture);
    if (!spec.ok) throw new Error('fixture');
    expect(narrationOf(spec.value)).toBe(GOAL);
    expect(narrationOf({ ...spec.value, tutorial: { ...spec.value.tutorial, goalLine: '  Go\n\tnow!  ' } })).toBe('Go now!');
    expect(narrationOf({ ...spec.value, tutorial: { ...spec.value.tutorial, goalLine: '   ' } })).toBeNull();
    expect(narrationOf({ ...spec.value, tutorial: { ...spec.value.tutorial, goalLine: 'x'.repeat(241) } })).toBeNull();
  });
});

describe('voice job on publish', () => {
  it('publishing starts one keyed job with the goal and does not wait for it', async () => {
    const calls = service({ post: 'hang' });
    const { status } = await publish('Voice hang');
    expect(status).toBe(201);
    const posts = voicePosts(calls);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]!.init!.body))).toEqual({ text: GOAL });
    expect(new Headers(posts[0]!.init!.headers).get('x-audio-key')).toBe(KEY);
  });

  it('a service that is down does not change the publication', async () => {
    service({ post: 'down' });
    expect((await publish('Voice down')).status).toBe(201);
    await expect(requestVoice(GOAL, { url: SERVICE, key: KEY })).resolves.toBe(false);
  });

  it('without the address or the key nothing is called', async () => {
    vi.stubEnv('PLAY_VOICE_KEY', '');
    const calls = service();
    expect((await publish('Voice off')).status).toBe(201);
    expect(calls).toHaveLength(0);
    const spec = readGameSpec(runnerFixture);
    if (!spec.ok) throw new Error('fixture');
    expect(scheduleVoice(spec.value)).toBe(false);
  });
});

describe('GET /api/play/games/:id/voice', () => {
  it('a finished voice is Ogg, immutable, fetched with the key under the text hash', async () => {
    const calls = service();
    const { id } = await publish('Voice ready');
    const response = await voice(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/ogg');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OGG);
    const get = calls.find((call) => call.init?.method !== 'POST')!;
    expect(get.url).toBe(`${SERVICE}/voice/${voiceIdOf(GOAL)}`);
    expect(new Headers(get.init!.headers).get('x-audio-key')).toBe(KEY);
  });

  it('a voice still generating, a broken tunnel, a sleeping service or no service is 204 without cache', async () => {
    service({ get: 'pending' });
    const { id } = await publish('Voice pending');
    for (const setup of [() => service({ get: 'pending' }), () => service({ get: 'broken' }), () => service({ get: 'down' }), () => vi.stubEnv('PLAY_VOICE_ENDPOINT', '')]) {
      setup();
      const response = await voice(id);
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('an unknown or malformed game is 404 and the service is not asked', async () => {
    const calls = service();
    expect((await voice('0'.repeat(64))).status).toBe(404);
    expect((await voice('../etc')).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
