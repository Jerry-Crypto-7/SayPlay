#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Deployment guard only. Never reads credentials, invokes a provider or echoes values. */
export function validateHost(env, platform = process.platform, exists = existsSync) {
  const missing = [];
  const requireValue = (name, predicate) => { if (!predicate(env[name] ?? '')) missing.push(name); };
  if (platform !== 'linux') missing.push('LINUX_HOST_REQUIRED');
  requireValue('WORLDSTREAM_HOST_READY', value => value === 'yes');
  requireValue('WORLDSMITH_BRANCH', value => value === 'live');
  requireValue('WORLDSMITH_MODEL_ENDPOINT', value => value === 'codex-cli');
  requireValue('WORLDSMITH_MODEL', value => value === 'gpt-6-astra');
  requireValue('WORLDSMITH_MODEL_EFFORT', value => value === 'medium');
  requireValue('WORLDSMITH_MODEL_PROFILE', value => value === 'subscription');
  requireValue('WORLDSMITH_MODEL_KEY', value => value.length > 0);
  requireValue('WORLDSMITH_CODEX_JS', value => isAbsolute(value) && exists(value));
  requireValue('WORLDSMITH_CALL_CAP', value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
  requireValue('WORLDSMITH_UPSTREAM_TIMEOUT_MS', value => Number(value) >= 1000 && Number(value) <= 300000);
  for (const name of ['WORLDSMITH_USD_PER_MTOK_IN', 'WORLDSMITH_USD_PER_MTOK_OUT', 'WORLDSMITH_SPEND_CAP_USD'])
    requireValue(name, value => Number.isFinite(Number(value)) && Number(value) > 0);
  requireValue('WORLDSMITH_SPEND_STORE_URL', value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
    catch { return false; }
  });
  requireValue('WORLDSMITH_SPEND_STORE_TOKEN', value => value.length > 0);
  requireValue('WORLDSMITH_SPEND_STORE_PREFIX', value => /^[a-zA-Z0-9:_-]{8,100}$/.test(value));
  requireValue('WORLDSMITH_OWNER_IDENTITY',value=>value==='trusted-proxy');
  requireValue('WORLDSMITH_OWNER_PROXY_SECRET',value=>/^[A-Za-z0-9_-]{32,256}$/.test(value));
  if (env.VERCEL !== undefined) missing.push('SERVERLESS_UNSUPPORTED');
  return { ok: missing.length === 0, missing,
    mode: 'single-linux-process', sessionRecovery: 'ordinary-sessions-expire-on-restart',
    authorization: 'operator-must-verify-hosted-CLI-use', providerContacted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateHost(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
