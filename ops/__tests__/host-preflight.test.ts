import { describe, expect, it } from 'vitest';
// @ts-expect-error Runtime operational script has no declaration file.
import { validateHost } from '../host/preflight.mjs';

const configured = {
  WORLDSTREAM_HOST_READY: 'yes', WORLDSMITH_BRANCH: 'live', WORLDSMITH_MODEL_ENDPOINT: 'codex-cli',
  WORLDSMITH_OWNER_IDENTITY:'trusted-proxy',WORLDSMITH_OWNER_PROXY_SECRET:'FIXTURE_ONLY_NOT_A_REAL_SECRET_000000000000',
  WORLDSMITH_MODEL: 'gpt-6-astra', WORLDSMITH_MODEL_EFFORT: 'medium', WORLDSMITH_MODEL_PROFILE: 'subscription',
  WORLDSMITH_MODEL_KEY: 'enabled', WORLDSMITH_CODEX_JS: '/opt/codex.js', WORLDSMITH_CALL_CAP: '200',
  WORLDSMITH_UPSTREAM_TIMEOUT_MS: '240000', WORLDSMITH_USD_PER_MTOK_IN: '1', WORLDSMITH_USD_PER_MTOK_OUT: '1',
  WORLDSMITH_SPEND_CAP_USD: '20', WORLDSMITH_SPEND_STORE_URL: 'https://ledger.invalid',
  WORLDSMITH_SPEND_STORE_TOKEN: 'private-value-never-log', WORLDSMITH_SPEND_STORE_PREFIX: 'worldstream:p20:production',
};

describe('host readiness is fail closed without changing local development', () => {
  it('rejects an unprovisioned native Windows environment without touching credentials', () => {
    const result = validateHost({}, 'win32', () => false);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('LINUX_HOST_REQUIRED');
    expect(result.providerContacted).toBe(false);
  });
  it('requires durable spend storage even with only one process', () => {
    const result = validateHost({ ...configured, WORLDSMITH_SPEND_STORE_TOKEN: '' }, 'linux', () => true);
    expect(result.missing).toEqual(['WORLDSMITH_SPEND_STORE_TOKEN']);
  });
  it('requires explicit authenticated proxy identity without revealing the injected value',()=>{
    const result=validateHost({...configured,WORLDSMITH_OWNER_PROXY_SECRET:''},'linux',()=>true);
    expect(result.missing).toEqual(['WORLDSMITH_OWNER_PROXY_SECRET']);
    expect(JSON.stringify(validateHost(configured,'linux',()=>true))).not.toContain(configured.WORLDSMITH_OWNER_PROXY_SECRET);
  });
  it('reports capabilities and missing names without disclosing values', () => {
    const result = validateHost(configured, 'linux', () => true);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(configured.WORLDSMITH_SPEND_STORE_TOKEN);
    expect(result.sessionRecovery).toBe('ordinary-sessions-expire-on-restart');
  });
  it('refuses serverless and a missing CLI runtime', () => {
    expect(validateHost({ ...configured, VERCEL: '1' }, 'linux', () => false).missing)
      .toEqual(['WORLDSMITH_CODEX_JS', 'SERVERLESS_UNSUPPORTED']);
  });
});
