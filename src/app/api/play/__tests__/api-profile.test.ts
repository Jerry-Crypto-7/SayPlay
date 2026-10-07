/**
 * Finální API profil (P27D T5, D1): `WORLDSMITH_MODEL_PROFILE=api` nad
 * dvojníkem poskytovatele ve formátu Anthropic Messages. Tytéž kontrakty jako
 * předplatné – vznik, opravné kolo, timeout – jdou skutečnými dveřmi a
 * skutečnými branami placené větve; podvržený je jen `fetch`. Klíč odejde
 * jen v hlavičce k poskytovateli, nikdy do odpovědi klientovi.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerFixture, genreAnswer } from '@/play/director/__fixtures__';
import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';
import { resetProcessSpendCap } from '@/server/spend-cap';

import { resetConcurrency } from '@/server/paid-slots';
import { __resetUpgrades } from '../_upgrade';
import { GET as readUpgrade } from '../games/[id]/upgrade/route';
import { POST as createGame } from '../games/route';

// Inject one failed verifier keypoint on the author's golden-hamster candidate.
// The same report seam is read during repair and final publication; quick is untouched.
const genre = vi.hoisted(() => ({ unplayable: false }));
vi.mock('../_report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_report')>();
  const reportFor: typeof actual.reportFor = compiled => {
    const report = actual.reportFor(compiled);
    if (!genre.unplayable || compiled.spec.title !== 'Golden Hamster Run') return report;
    return { ...report, publishEligible:false, keypoints:report.keypoints.map((point,index)=>index===0 ? {...point,passed:false,failures:['injected_claim requires reviewed title Repaired Hamster Run']} : point) };
  };
  return { ...actual, reportFor };
});

// Bez předpony `sk-`: tvar skutečného klíče by zastavil `blind-check` před pushem.
const KEY = 'test-key-d1-never-leaves-the-server';

const API = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_PROFILE: 'api',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: KEY,
  WORLDSMITH_USD_PER_MTOK_IN: '3',
  WORLDSMITH_USD_PER_MTOK_OUT: '15',
  WORLDSMITH_SPEND_CAP_USD: '5',
};

const SENTENCE = 'a hamster runs through a supermarket';
const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' };

type Scripted = unknown | 'timeout';

/** Co „poskytovatel“ odpoví na další volání a co od nás dostal. */
const upstream = { script: [] as Scripted[], requests: [] as { url: string; headers: Headers; body: string }[] };

beforeEach(() => {
  __resetProcessVersionStore();
  __resetUpgrades();
  resetRateWindows();
  resetConcurrency();
  for (const [key, value] of Object.entries(API)) vi.stubEnv(key, value);
  resetProcessSpendCap();
  genre.unplayable = false;
  upstream.script = [];
  upstream.requests = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    upstream.requests.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body ?? '') });
    const next = upstream.script.shift();
    if (next === undefined) return new Response('upstream down', { status: 503 });
    if (next === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(next) }], usage: { input_tokens: 900, output_tokens: 200 } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetProcessSpendCap();
  resetConcurrency();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Věta dveřmi, pak dotazy na vylepšení až do konce; vrací obě odpovědi i jejich text. */
async function create(): Promise<{ versionId: string; outcome: Record<string, any>; seen: string }> {
  const response = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: CALLER, body: JSON.stringify({ sentence: SENTENCE }) }));
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  const { versionId } = JSON.parse(text) as { versionId: string };
  let outcome: Record<string, any> = {};
  let seen = text + JSON.stringify([...response.headers]);
  await vi.waitFor(
    async () => {
      const polled = await readUpgrade(new Request(`http://play.test/api/play/games/${versionId}/upgrade`, { headers: CALLER }), params(versionId));
      const body = await polled.text();
      seen += body + JSON.stringify([...polled.headers]);
      outcome = JSON.parse(body);
      expect(outcome.status).not.toBe('pending');
    },
    { timeout: 20_000 },
  );
  return { versionId, outcome, seen };
}

function brokenSwitch(): unknown {
  const broken = structuredClone(answerFixture('good-switch_puzzle')) as { mechanics: { params: Record<string, unknown> }[] };
  broken.mechanics[0].params.required = ['red', 'blue', 'green'];
  return broken;
}

describe('final API profile over a provider double (D1)', () => {
  it('create: one call in the Messages format, the key only in the provider header, the AI child stored', async () => {
    // Model vybírá žánr (P32B T4), hru skládá modul žánru.
    upstream.script = [genreAnswer({ genre: 'runner', mode: 'default', hero: 'hamster', cast: [], setting: 'supermarket', palette: 'supermarket' })];
    const { versionId, outcome, seen } = await create();
    expect(outcome.status).toBe('ready');
    expect(upstream.requests).toHaveLength(1);
    const [request] = upstream.requests;
    expect(request.url).toBe(API.WORLDSMITH_MODEL_ENDPOINT);
    expect(request.headers.get('x-api-key')).toBe(KEY);
    expect(JSON.parse(request.body)).toMatchObject({ messages: expect.any(Array), max_tokens: expect.any(Number) });
    // Klíč nejde do těla k poskytovateli, ani do žádné odpovědi klientovi.
    expect(request.body).not.toContain(KEY);
    expect(seen).not.toContain(KEY);
    expect(await versionStoreFromEnv(process.env).childrenOf(versionId)).toHaveLength(1);
  });

  it('repair: an unplayable answer gets one repair round and the repaired game is published', async () => {
    genre.unplayable = true;
    // Odpověď věrná větě (P32B T5) – nevěrnou by režisér přepnul na jiný žánr místo opravného kola.
    // P39: věc ke sběru je výchozí věc supermarketu, žalud by kontrola obsazení shodila jako vymyšlený.
    const faithful = genreAnswer({ genre:'runner',mode:'default',hero: 'golden hamster', cast: [], setting: 'supermarket', palette: 'supermarket' });
    upstream.script = [faithful, [{ op: 'replace', path: '/title', value: 'Repaired Hamster Run' }]];
    const { outcome } = await create();
    expect(outcome.status).toBe('ready');
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1].body).toContain('KEYPOINT_FAILED');
  });

  it('timeout: the provider timing out ends as the word draft with an honest reason, no child', async () => {
    upstream.script = ['timeout'];
    const { versionId, outcome } = await create();
    expect(outcome).toEqual({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' });
    expect(await versionStoreFromEnv(process.env).childrenOf(versionId)).toEqual([]);
  });

  it('a spend cap of 0 USD sends nothing to the provider', async () => {
    vi.stubEnv('WORLDSMITH_SPEND_CAP_USD', '0');
    resetProcessSpendCap();
    upstream.script = [genreAnswer()];
    const { outcome } = await create();
    expect(outcome.status).toBe('draft-final');
    expect(upstream.requests).toHaveLength(0);
  });
});
