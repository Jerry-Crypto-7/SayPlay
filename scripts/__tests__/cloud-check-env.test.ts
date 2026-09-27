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

import { checkEnv, parseEnvFile } from '../cloud/check-env.mjs';

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
  ])('refuses an endpoint on %s', (_what, name, value) => {
    expect(names({ ...GOOD, [name]: value })).toEqual([name]);
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
      ['WORLDSMITH_FALLBACK_SPEND_CAP_USD', 'WORLDSMITH_MODEL_ENDPOINT', 'WORLDSMITH_MODEL_PROFILE', 'WORLDSMITH_SPEND_CAP_USD'].sort(),
    );
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
