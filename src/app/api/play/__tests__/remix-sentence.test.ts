/**
 * Remix vlastní větou (P27C T4): `POST …/remix { sentence }`. Brány placené
 * větve jsou skutečné (`callDirectorModel` – objednávka, vypínač, strop,
 * počet volajícího); podvržený je jen `fetch` k poskytovateli, který vrací
 * scénář záplat. Nikam se nevolá.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import chaseEscape from '@/play/__fixtures__/chase_escape.json';
import platform from '@/play/arcade/__fixtures__/platform.json';
import runner from '@/play/arcade/__fixtures__/runner.json';
import { __resetProcessVersionStore, DEFAULT_WRITE_LIMITS, memoryVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';
import { resetProcessSpendCap } from '@/server/spend-cap';

import { resetConcurrency } from '@/server/paid-slots';
import { directorCallerOf, store } from '../_publish';
import { __rememberedRemixes, __resetRemixes, MAX_REMEMBERED_REMIXES, remixJobId, startRemix } from '../_remix-jobs';
import { GET as readGame } from '../games/[id]/route';
import { GET as readRemix, POST as remix } from '../games/[id]/remix/route';
import { POST as createGame } from '../games/route';

const LIVE = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_USD_PER_MTOK_OUT: '15',
  WORLDSMITH_SPEND_CAP_USD: '5',
};

const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };

type Scripted = unknown[] | { readonly text: string } | 'timeout';

/** Co „model“ odpoví na další volání; `gate` drží odpověď, dokud ji test nepustí. */
const upstream = { script: [] as Scripted[], calls: 0, gate: Promise.resolve() as Promise<void> };
const temporary: string[] = [];

beforeEach(() => {
  __resetProcessVersionStore();
  __resetRemixes();
  resetRateWindows();
  resetConcurrency();
  for (const [key, value] of Object.entries(LIVE)) vi.stubEnv(key, value);
  resetProcessSpendCap();
  upstream.script = [];
  upstream.calls = 0;
  upstream.gate = Promise.resolve();
  vi.stubGlobal('fetch', async () => {
    upstream.calls += 1;
    await upstream.gate;
    const next = upstream.script.shift();
    if (next === undefined) return new Response('upstream down', { status: 503 });
    if (next === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    const text = Array.isArray(next) ? JSON.stringify(next) : next.text;
    return Response.json({ content: [{ type: 'text', text }], usage: { input_tokens: 900, output_tokens: 200 } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetProcessSpendCap();
  resetConcurrency();
  delete process.env.WORLDSMITH_CONTROL_FILE;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function publish(spec: unknown): Promise<string> {
  const response = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: CALLER, body: JSON.stringify({ spec }) }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBeLessThan(300);
  return ((await response.json()) as { versionId: string }).versionId;
}

async function send(parentId: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await remix(new Request(`http://play.test/api/play/games/${parentId}/remix`, { method: 'POST', headers: CALLER, body: JSON.stringify(body) }), params(parentId));
  return { status: response.status, body: await response.json() };
}

async function status(parentId: string, job: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await readRemix(new Request(`http://play.test/api/play/games/${parentId}/remix?job=${job}`, { headers: CALLER }), params(parentId));
  return { status: response.status, body: await response.json() };
}

async function settled(parentId: string, job: string): Promise<Record<string, any>> {
  let last: Record<string, any> = {};
  await vi.waitFor(
    async () => {
      last = (await status(parentId, job)).body;
      expect(last.status).not.toBe('pending');
    },
    { timeout: 20_000 },
  );
  return last;
}

async function game(id: string): Promise<Record<string, any>> {
  return (await readGame(new Request(`http://play.test/api/play/games/${id}`), params(id))).json();
}

async function remixed(parentId: string, sentence: string): Promise<Record<string, any>> {
  const started = await send(parentId, { sentence });
  expect(started.status).toBe(202);
  return settled(parentId, started.body.job);
}

describe('POST …/remix { sentence }', () => {
  it('„add snow“ změní jen prostředí: 202 → ready, dítě s rodičem, rodič beze změny', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [[{ op: 'replace', path: '/theme', value: { setting: 'snowy supermarket at night', mood: 'frantic' } }]];
    const started = await send(parentId, { sentence: 'add snow' });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ status: 'pending', job: expect.stringMatching(/^[0-9a-f]{32}$/), deadlineAt: expect.any(String) });
    expect(Date.parse(started.body.deadlineAt) - Date.now()).toBeGreaterThan(280_000);

    const ready = await settled(parentId, started.body.job);
    expect(ready).toEqual({ status: 'ready', versionId: expect.any(String), changed: ['setting'] });
    const child = await game(ready.versionId);
    expect(child.version.parentId).toBe(parentId);
    expect(child.spec.theme.setting).toBe('snowy supermarket at night');
    const parentSpec = (await game(parentId)).spec;
    expect({ ...child.spec, theme: parentSpec.theme }).toEqual(parentSpec);
    expect(parentSpec.theme).toEqual(chaseEscape.theme);
    expect(upstream.calls).toBe(1);
  });

  it('„make enemies faster“ změní jen rychlost pronásledovatele', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [[{ op: 'replace', path: '/mechanics/0/params/speed', value: 'fast' }]];
    const ready = await remixed(parentId, 'make enemies faster');
    expect(ready).toEqual({ status: 'ready', versionId: expect.any(String), changed: ['chaser speed'] });
    const child = await game(ready.versionId);
    expect(child.spec.mechanics[0].params.speed).toBe('fast');
    expect(child.spec.control).toBeUndefined();
  });

  it('záplata, která mění ovládání, o které věta nežádala → final UNASKED_CHANGE', async () => {
    const parentId = await publish(runner);
    upstream.script = [
      [
        { op: 'replace', path: '/control', value: 'platform' },
        { op: 'replace', path: '/controlParams', value: platform.controlParams },
      ],
    ];
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'UNASKED_CHANGE' });
  });

  it('neplatná záplata a nečitelný JSON od modelu → final MALFORMED', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [{ text: '{"hello": 1}' }, { text: 'sure! here is the patch: [{' }];
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'MALFORMED' });
    expect(await remixed(parentId, 'add rain')).toEqual({ status: 'final', reason: 'MALFORMED' });
  });

  it('záplata, která sahá na /schema, se nepoužije', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [[{ op: 'replace', path: '/schema', value: 'gamespec.v2' }]];
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'MALFORMED' });
  });

  it('timeout transportu → final MODEL_UNAVAILABLE a nové odeslání dostane nový pokus', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = ['timeout'];
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'MODEL_UNAVAILABLE' });
    upstream.script = [[{ op: 'replace', path: '/theme', value: { setting: 'snowy supermarket at night', mood: 'frantic' } }]];
    expect((await remixed(parentId, 'add snow')).status).toBe('ready');
    expect(upstream.calls).toBe(2);
  });

  it('dvě stejné věty souběžně = jedna práce a jedno volání', async () => {
    const parentId = await publish(chaseEscape);
    let release: () => void = () => {};
    upstream.gate = new Promise((resolve) => {
      release = resolve;
    });
    upstream.script = [[{ op: 'replace', path: '/theme', value: { setting: 'snowy supermarket at night', mood: 'frantic' } }]];
    const [a, b] = await Promise.all([send(parentId, { sentence: 'add snow' }), send(parentId, { sentence: '  Add   SNOW ' })]);
    expect(a.body.job).toBe(b.body.job);
    release();
    expect((await settled(parentId, a.body.job)).status).toBe('ready');
    expect(upstream.calls).toBe(1);
  });

  it('věta, která je čipem, jde cestou čipu: 201 hned a bez modelu', async () => {
    const parentId = await publish(chaseEscape);
    const response = await send(parentId, { sentence: 'Make it harder' });
    expect(response.status).toBe(201);
    expect(response.body.parentId).toBe(parentId);
    expect(upstream.calls).toBe(0);
  });

  it('neexistující rodič 404, prázdná, dlouhá nebo zdvojená věta 400', async () => {
    expect((await send('a'.repeat(32), { sentence: 'add snow' })).status).toBe(404);
    const parentId = await publish(chaseEscape);
    expect((await send(parentId, { sentence: '   ' })).status).toBe(400);
    expect((await send(parentId, { sentence: '\u0000\u0007' })).status).toBe(400);
    expect((await send(parentId, { sentence: 'x'.repeat(141) })).status).toBe(400);
    expect((await send(parentId, { sentence: 'add snow', chip: 'harder' })).status).toBe(400);
    expect(upstream.calls).toBe(0);
  });

  it('neznámá práce nebo práce jiného rodiče je 404', async () => {
    const parentId = await publish(chaseEscape);
    const otherId = await publish(runner);
    upstream.script = [[{ op: 'replace', path: '/theme', value: { setting: 'snowy supermarket at night', mood: 'frantic' } }]];
    const started = await send(parentId, { sentence: 'add snow' });
    expect((await status(otherId, started.body.job)).status).toBe(404);
    expect((await status(parentId, 'f'.repeat(32))).status).toBe(404);
  });
});

/** `__resetRemixes()` zahodí paměť procesu, úložiště zůstane – tak vypadá restart nebo jiná instance (T4a). */
describe('stav práce přežije restart a jinou instanci', () => {
  const SNOW = [{ op: 'replace', path: '/theme', value: { setting: 'snowy supermarket at night', mood: 'frantic' } }];

  it('hotové dítě se najde z úložiště: GET i nové odeslání bez druhého volání modelu', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [SNOW];
    const started = await send(parentId, { sentence: 'add snow' });
    const ready = await settled(parentId, started.body.job);
    expect(ready.status).toBe('ready');

    __resetRemixes();
    expect(await status(parentId, started.body.job)).toEqual({ status: 200, body: ready });
    upstream.script = [SNOW];
    expect(await remixed(parentId, 'add snow')).toEqual(ready);
    expect(upstream.calls).toBe(1);
  });

  it('uložené ready, jehož dítě vypršelo, neplatí: GET řekne FAILED a nové odeslání postaví dítě znovu', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [SNOW];
    const started = await send(parentId, { sentence: 'add snow' });
    const ready = await settled(parentId, started.body.job);
    expect(ready.status).toBe('ready');

    __resetRemixes();
    const versions = store();
    const get = versions.get.bind(versions);
    vi.spyOn(versions, 'get').mockImplementation(async (id) => (id === ready.versionId ? null : get(id)));
    expect((await status(parentId, started.body.job)).body).toEqual({ status: 'final', reason: 'FAILED' });
    upstream.script = [SNOW];
    expect((await remixed(parentId, 'add snow')).status).toBe('ready');
    expect(upstream.calls).toBe(2);
  });

  it('běžící práce není na jiné instanci 404 a druhé odeslání model nezaplatí', async () => {
    const parentId = await publish(chaseEscape);
    let release: () => void = () => {};
    upstream.gate = new Promise((resolve) => {
      release = resolve;
    });
    upstream.script = [SNOW];
    const started = await send(parentId, { sentence: 'add snow' });
    await vi.waitFor(() => expect(upstream.calls).toBe(1));

    __resetRemixes();
    expect((await status(parentId, started.body.job)).body.status).toBe('pending');
    const again = await send(parentId, { sentence: 'add snow' });
    expect(again.status).toBe(202);
    expect(again.body.job).toBe(started.body.job);
    release();
    expect((await settled(parentId, started.body.job)).status).toBe('ready');
    expect(upstream.calls).toBe(1);
  });

  it('dvě instance ve stejné chvíli zaplatí model jednou – záznam se zabírá atomicky (T4d)', async () => {
    const parentId = await publish(chaseEscape);
    let release: () => void = () => {};
    upstream.gate = new Promise((resolve) => {
      release = resolve;
    });
    upstream.script = [SNOW, SNOW];
    const versions = store();
    const parent = (await versions.get(parentId))!;
    const request = { sentence: 'add snow', startedAt: Date.now(), caller: directorCallerOf(new Request('http://play.test', { headers: CALLER })) };
    // Obě instance čtou úložiště dřív, než kterákoli zapíše, že práce běží.
    startRemix(versions, parent, request);
    __resetRemixes();
    startRemix(versions, parent, request);
    await vi.waitFor(() => expect(upstream.calls).toBe(1));
    release();
    expect((await settled(parentId, remixJobId(parentId, 'add snow'))).status).toBe('ready');
    expect(upstream.calls).toBe(1);
  });

  it('1001 odmítnutí bez placeného volání nevytlačí cizí hotovou práci z paměti (T4b)', async () => {
    vi.stubEnv('PLAY_DIRECTOR_CALLS_PER_CALLER', '1');
    const parentId = await publish(chaseEscape);
    upstream.script = [SNOW];
    const started = await send(parentId, { sentence: 'add snow' });
    const ready = await settled(parentId, started.body.job);
    expect(ready.status).toBe('ready');

    const versions = store();
    const parent = (await versions.get(parentId))!;
    // Mimo route: strop frekvence by zastavil dřív. Volající už svůj jeden hovor vyčerpal.
    for (let n = 0; n <= MAX_REMEMBERED_REMIXES; n += 1) startRemix(versions, parent, { sentence: `add snow ${String(n)}`, startedAt: Date.now(), caller: directorCallerOf(new Request('http://play.test', { headers: CALLER })) });
    await vi.waitFor(() => expect(__rememberedRemixes()).toBe(1), { timeout: 20_000 });
    expect(upstream.calls).toBe(1);
    expect(await status(parentId, started.body.job)).toEqual({ status: 200, body: ready });
    const refused = remixJobId(parentId, `add snow ${String(MAX_REMEMBERED_REMIXES)}`);
    expect((await status(parentId, refused)).body).toEqual({ status: 'final', reason: 'MODEL_UNAVAILABLE' });
  });

  it('po selhání opravy nové odeslání zaplatí jen opravu, ne první volání (T4c)', async () => {
    const parentId = await publish(chaseEscape);
    // Deset rolí navíc = TOO_COMPLEX, blokující nález kritika, takže přijde opravné kolo.
    const piles = Array.from({ length: 10 }, (_, n) => ({ op: 'add', path: '/roles/-', value: { id: `pile${String(n)}`, kind: 'prop', label: 'snow pile' } }));
    const trim = Array.from({ length: 10 }, (_, n) => ({ op: 'remove', path: `/roles/${String(chaseEscape.roles.length + 9 - n)}` }));
    upstream.script = [[{ op: 'replace', path: '/budgets/maxRules', value: 200 }, ...piles], 'timeout'];
    expect(await remixed(parentId, 'add snow piles')).toEqual({ status: 'final', reason: 'MODEL_UNAVAILABLE' });
    expect(upstream.calls).toBe(2);

    __resetRemixes();
    upstream.script = [trim];
    expect((await remixed(parentId, 'add snow piles')).status).toBe('ready');
    expect(upstream.calls).toBe(3);
  });

  it('paměťové úložiště nechá záznam vypršet po jeho TTL (T4d)', async () => {
    let now = Date.UTC(2026, 8, 24);
    const versions = memoryVersionStore(DEFAULT_WRITE_LIMITS, () => now);
    await versions.rememberUpgradeVerdict('remix:job', 'kept', 10);
    now += 9_000;
    expect(await versions.upgradeVerdict('remix:job')).toBe('kept');
    now += 2_000;
    expect(await versions.upgradeVerdict('remix:job')).toBeNull();
    // Po vypršení jde záznam zabrat znovu.
    expect(await versions.claimUpgradeVerdict('remix:job', 'again', 10)).toBe(true);
    expect(await versions.claimUpgradeVerdict('remix:job', 'late', 10)).toBe(false);
  });

  it('verdikt o větě platí i po restartu, výpadek ne', async () => {
    const parentId = await publish(chaseEscape);
    upstream.script = [{ text: '{"hello": 1}' }];
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'MALFORMED' });
    __resetRemixes();
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'MALFORMED' });
    expect(upstream.calls).toBe(1);

    upstream.script = ['timeout'];
    expect(await remixed(parentId, 'add rain')).toEqual({ status: 'final', reason: 'MODEL_UNAVAILABLE' });
    __resetRemixes();
    upstream.script = [SNOW];
    expect((await remixed(parentId, 'add rain')).status).toBe('ready');
    expect(upstream.calls).toBe(3);
  });
});

describe('brány placené větve platí jako u upgradu', () => {
  function control(off: string[]): void {
    const dir = mkdtempSync(join(tmpdir(), 'play-remix-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off }));
    process.env.WORLDSMITH_CONTROL_FILE = file;
  }

  it('vypínač sessions → 503 a nic se nespustí', async () => {
    const parentId = await publish(chaseEscape);
    control(['sessions']);
    const response = await send(parentId, { sentence: 'add snow' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DISABLED');
    expect(upstream.calls).toBe(0);
  });

  it('vypínač upstream → model se nevolá, final MODEL_UNAVAILABLE', async () => {
    const parentId = await publish(chaseEscape);
    control(['upstream']);
    expect(await remixed(parentId, 'add snow')).toEqual({ status: 'final', reason: 'MODEL_UNAVAILABLE' });
    expect(upstream.calls).toBe(0);
  });

  it('denní počet volání na volajícího: nad mez se model nevolá', async () => {
    vi.stubEnv('PLAY_DIRECTOR_CALLS_PER_CALLER', '1');
    const parentId = await publish(chaseEscape);
    upstream.script = [[{ op: 'replace', path: '/theme', value: { setting: 'snowy supermarket at night', mood: 'frantic' } }]];
    expect((await remixed(parentId, 'add snow')).status).toBe('ready');
    expect(await remixed(parentId, 'add rain')).toEqual({ status: 'final', reason: 'MODEL_UNAVAILABLE' });
    expect(upstream.calls).toBe(1);
  });

  it('strop frekvence → 429', async () => {
    const parentId = await publish(chaseEscape);
    let limited = 0;
    for (let n = 0; n < 80 && limited === 0; n += 1) {
      if ((await send(parentId, { sentence: '' })).status === 429) limited += 1;
    }
    expect(limited).toBe(1);
  });
});
