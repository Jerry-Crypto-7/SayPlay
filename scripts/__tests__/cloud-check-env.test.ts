/**
 * Kontrola produkční konfigurace (P30A T6): nasazené demo nesmí stát na
 * domácím PC ani na osobním předplatném a musí mít oba dolarové stropy.
 * Nikdo se na ni při nasazení nedívá, takže každý důvod má vlastní případ
 * a skript vrací nenulu, na které nasazení skončí.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { READER_MAX_OUTPUT_TOKENS as CLIENT_READER_MAX_OUTPUT_TOKENS } from '../../src/play/read/client';
import { MAX_PLAY_DIRECTOR_SLOTS } from '../../src/server/paid-slots';
import { checkEnv, parseEnvFile, READER_MAX_OUTPUT_TOKENS } from '../cloud/check-env.mjs';

const SCRIPT = 'scripts/cloud/check-env.mjs';
const EXAMPLE = 'scripts/cloud/env.production.example';

/** Nejmenší konfigurace, která projde; každý případ z ní jednu věc pokazí. */
const GOOD = {
  WORLDSMITH_MODEL_PROFILE: 'metered',
  WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.together.xyz',
  WORLDSMITH_FALLBACK_ENDPOINT: 'openai:https://api.openai.com',
  PLAY_VOICE_ENDPOINT: 'openai-speech:https://api.deepinfra.com/v1/openai',
  WORLDSMITH_SPEND_CAP_USD: '30',
  WORLDSMITH_FALLBACK_SPEND_CAP_USD: '20',
  // Primár: 8000 tokenů × 0,20 USD/Mtok = 0,0016 USD na volání → 30 USD potřebuje 18 750 volání.
  WORLDSMITH_USD_PER_MTOK_OUT: '0.2',
  WORLDSMITH_CALL_CAP: '20000',
  // Záloha: 8000 × 10 USD/Mtok = 0,08 USD → 20 USD potřebuje 250 volání.
  WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT: '10',
  WORLDSMITH_FALLBACK_CALL_CAP: '300',
} as const;

const names = (vars: Record<string, string>) => checkEnv(vars).map((problem) => problem.name);

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function envFile(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'check-env-')), '.env.production');
  writeFileSync(file, text);
  return file;
}

describe('checkEnv', () => {
  it('passes a config that needs neither the home PC nor the subscription', () => {
    expect(checkEnv(GOOD)).toEqual([]);
  });

  it.each([
    ['a cloudflared tunnel', 'WORLDSMITH_MODEL_ENDPOINT', 'openai:https://quiet-fox.trycloudflare.com'],
    ['127.0.0.1', 'PLAY_ENV_ENDPOINT', 'http://127.0.0.1:8793'],
    ['localhost', 'PLAY_VOICE_ENDPOINT', 'http://LOCALHOST:8794'],
    ['codex-cli', 'WORLDSMITH_MODEL_ENDPOINT', 'codex-cli'],
    ['llamacpp:', 'WORLDSMITH_FALLBACK_ENDPOINT', 'llamacpp:https://llm.example.com'],
    ['a local store address', 'KV_REST_API_URL', 'http://localhost:8079'],
    ['a home-network address', 'WORLDSMITH_MODEL_ENDPOINT', 'openai:http://192.168.1.20:18767'],
    ['a 10.x address', 'PLAY_ENV_ENDPOINT', 'http://10.0.0.5:8793'],
    ['a 172.16-31.x address', 'PLAY_ENV_ENDPOINT', 'http://172.20.0.1:8793'],
    ['IPv6 loopback', 'PLAY_VOICE_ENDPOINT', 'http://[::1]:8794'],
    ['0.0.0.0', 'PLAY_ENV_ENDPOINT', 'http://0.0.0.0:8793'],
  ])('refuses an endpoint on %s', (_what, name, value) => {
    expect(names({ ...GOOD, [name]: value })).toEqual([name]);
  });

  it('keeps public hosts that only look like private ranges', () => {
    expect(checkEnv({ ...GOOD, PLAY_ENV_ENDPOINT: 'https://172.32.0.1', WORLDSMITH_MODEL_ENDPOINT: 'openai:https://api.example.com/v10.1' })).toEqual([]);
  });

  it('does not read a home-PC word in a variable that is not an address', () => {
    expect(checkEnv({ ...GOOD, WORLDSMITH_BRANCH: 'localhost-fix' })).toEqual([]);
  });

  it.each(['WORLDSMITH_SPEND_CAP_USD', 'WORLDSMITH_FALLBACK_SPEND_CAP_USD'])('refuses a missing, empty or unreadable %s', (name) => {
    const { [name as keyof typeof GOOD]: _dropped, ...without } = GOOD;
    expect(names(without)).toEqual([name]);
    expect(names({ ...GOOD, [name]: '' })).toEqual([name]);
    expect(names({ ...GOOD, [name]: '5 USD' })).toEqual([name]);
    expect(names({ ...GOOD, [name]: '-1' })).toEqual([name]);
  });

  it('refuses the subscription profile and a profile typo', () => {
    expect(names({ ...GOOD, WORLDSMITH_MODEL_PROFILE: 'subscription' })).toEqual(['WORLDSMITH_MODEL_PROFILE']);
    expect(names({ ...GOOD, WORLDSMITH_MODEL_PROFILE: ' Subscription ' })).toEqual(['WORLDSMITH_MODEL_PROFILE']);
    expect(names({ ...GOOD, WORLDSMITH_MODEL_PROFILE: 'metred' })).toEqual(['WORLDSMITH_MODEL_PROFILE']);
    expect(checkEnv({ ...GOOD, WORLDSMITH_MODEL_PROFILE: 'api' })).toEqual([]);
    // Upstream čte profil bez ohledu na velikost písmen; kontrola nesmí odmítnout, co projde.
    expect(checkEnv({ ...GOOD, WORLDSMITH_MODEL_PROFILE: ' METERED ' })).toEqual([]);
  });

  it('lists every problem, not just the first', () => {
    expect(names({ WORLDSMITH_MODEL_PROFILE: 'subscription', WORLDSMITH_MODEL_ENDPOINT: 'codex-cli' }).sort()).toEqual(
      [
        'WORLDSMITH_CALL_CAP',
        'WORLDSMITH_FALLBACK_CALL_CAP',
        'WORLDSMITH_FALLBACK_SPEND_CAP_USD',
        'WORLDSMITH_MODEL_ENDPOINT',
        'WORLDSMITH_MODEL_PROFILE',
        'WORLDSMITH_SPEND_CAP_USD',
      ].sort(),
    );
  });
});

describe('checkEnv – the call cap must not bite before the dollar cap (T3a)', () => {
  const LEDGERS = [
    { who: 'primary', calls: 'WORLDSMITH_CALL_CAP', tokens: 'WORLDSMITH_MAX_OUTPUT_TOKENS', price: 'WORLDSMITH_USD_PER_MTOK_OUT', cap: 'WORLDSMITH_SPEND_CAP_USD', low: '18000', enough: '19000', halfCalls: '10000' },
    { who: 'fallback', calls: 'WORLDSMITH_FALLBACK_CALL_CAP', tokens: 'WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS', price: 'WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT', cap: 'WORLDSMITH_FALLBACK_SPEND_CAP_USD', low: '240', enough: '260', halfCalls: '130' },
  ] as const;

  it.each(LEDGERS)('$who: refuses a missing, empty or unreadable call cap', ({ calls }) => {
    const { [calls]: _dropped, ...without } = GOOD;
    expect(names(without)).toEqual([calls]);
    expect(names({ ...GOOD, [calls]: '' })).toEqual([calls]);
    expect(names({ ...GOOD, [calls]: 'lots' })).toEqual([calls]);
  });

  it.each(LEDGERS)('$who: refuses a call cap below dollar cap / worst case, with 8000 output tokens by default', ({ calls, low, enough }) => {
    expect(names({ ...GOOD, [calls]: low })).toEqual([calls]);
    expect(checkEnv({ ...GOOD, [calls]: enough })).toEqual([]);
  });

  it.each(LEDGERS)('$who: reads its own output-token limit', ({ calls, tokens, halfCalls }) => {
    // Dvojnásobek tokenů = dvakrát dražší nejhorší případ = stačí polovina volání.
    expect(names({ ...GOOD, [calls]: halfCalls })).toEqual([calls]);
    expect(checkEnv({ ...GOOD, [calls]: halfCalls, [tokens]: '16000' })).toEqual([]);
  });

  it.each(LEDGERS)('$who: a missing output price cannot vouch for the call cap', ({ price }) => {
    const { [price]: _dropped, ...without } = GOOD;
    expect(names(without)).toEqual([price]);
  });

  it.each(LEDGERS)('$who: a zero dollar cap needs no calls', ({ calls, cap, price }) => {
    const { [price]: _dropped, ...without } = GOOD;
    expect(checkEnv({ ...without, [cap]: '0', [calls]: '0' })).toEqual([]);
  });

  it('the primary and the fallback are checked against their own numbers', () => {
    // Záloha drahá, primár levný: nízký strop zálohy nesmí projít kvůli ceně primáru a naopak.
    expect(names({ ...GOOD, WORLDSMITH_FALLBACK_CALL_CAP: '19000', WORLDSMITH_CALL_CAP: '300' })).toEqual(['WORLDSMITH_CALL_CAP']);
  });
});

describe('checkEnv – optional play director slots (P53 T1)', () => {
  it('passes a missing or empty PLAY_DIRECTOR_SLOTS and every value the server takes', () => {
    expect(checkEnv({ ...GOOD, PLAY_DIRECTOR_SLOTS: '' })).toEqual([]);
    for (let slots = 1; slots <= MAX_PLAY_DIRECTOR_SLOTS; slots += 1) expect(checkEnv({ ...GOOD, PLAY_DIRECTOR_SLOTS: String(slots) })).toEqual([]);
  });

  it.each(['0', String(MAX_PLAY_DIRECTOR_SLOTS + 1), 'two', '1.5'])('refuses PLAY_DIRECTOR_SLOTS=%s, which the server would replace with 2', (raw) => {
    expect(names({ ...GOOD, PLAY_DIRECTOR_SLOTS: raw })).toEqual(['PLAY_DIRECTOR_SLOTS']);
  });
});

describe('checkEnv – the sentence reader (P58B T4)', () => {
  // Čtečka astra jen pro AI verzi: 1024 tokenů × 50 USD/Mtok = 0,0512 USD → 20 USD potřebuje 391 volání.
  const READER = { PLAY_READER: 'on', PLAY_READER_PATH: 'ai', PLAY_READER_SPEND_CAP_USD: '20', PLAY_READER_USD_PER_MTOK_OUT: '50', PLAY_READER_CALL_CAP: '391' } as const;

  it('passes a reader that reads for the AI version under its own caps, and checks nothing while it is off', () => {
    expect(checkEnv({ ...GOOD, ...READER })).toEqual([]);
    expect(checkEnv({ ...GOOD, PLAY_READER: 'off', PLAY_READER_PATH: 'fast' })).toEqual([]);
  });

  it.each(['', 'fast', 'AI'])('refuses PLAY_READER_PATH=%s: no measured hosted reader fits the fast path', (path) => {
    expect(names({ ...GOOD, ...READER, PLAY_READER_PATH: path })).toEqual(['PLAY_READER_PATH']);
  });

  it.each(['', 'twenty', '-1'])('refuses a reader spend cap of "%s"', (cap) => {
    expect(names({ ...GOOD, ...READER, PLAY_READER_SPEND_CAP_USD: cap })).toEqual(['PLAY_READER_SPEND_CAP_USD']);
  });

  it('measures the reader call cap against its fixed 1024 output tokens, not the director default', () => {
    expect(names({ ...GOOD, ...READER, PLAY_READER_CALL_CAP: '390' })).toEqual(['PLAY_READER_CALL_CAP']);
    expect(names({ ...GOOD, ...READER, PLAY_READER_CALL_CAP: '' })).toEqual(['PLAY_READER_CALL_CAP']);
    const { PLAY_READER_USD_PER_MTOK_OUT: _price, ...unpriced } = READER;
    expect(names({ ...GOOD, ...unpriced })).toEqual(['PLAY_READER_USD_PER_MTOK_OUT']);
  });

  it('keeps the fixed reader output in step with the client', () => {
    expect(READER_MAX_OUTPUT_TOKENS).toBe(CLIENT_READER_MAX_OUTPUT_TOKENS);
  });
});

describe('parseEnvFile', () => {
  it('reads dotenv lines the way vercel env pull writes them', () => {
    const text = ['# comment', '', 'export A=1', 'B="two words"', "C='x'", 'D=plain # note', 'E=', '  F = spaced  ', 'not a line'].join('\n');
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'two words', C: 'x', D: 'plain', E: '', F: 'spaced' });
  });
});

describe('node scripts/cloud/check-env.mjs', () => {
  it('passes the production example', () => {
    const { status, out } = run(EXAMPLE);
    expect(status, out).toBe(0);
  });

  it('fails with 1 and names the variable, never its value', () => {
    const tunnel = { ...GOOD, WORLDSMITH_MODEL_ENDPOINT: 'openai:https://secret-fox.trycloudflare.com' };
    const file = envFile(`${Object.entries(tunnel).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    const { status, out } = run(file);
    expect(status).toBe(1);
    expect(out).toContain('WORLDSMITH_MODEL_ENDPOINT');
    expect(out).not.toContain('secret-fox');
  });

  it('fails with 2 on a missing argument or an unreadable file', () => {
    expect(run().status).toBe(2);
    expect(run(join(tmpdir(), 'no-such-dir', '.env')).status).toBe(2);
  });
});
