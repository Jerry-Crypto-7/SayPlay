/**
 * Zavaděč pro skripty tréninku: `scripts/ts-paths.mjs` (cesty `@/`, přípony)
 * a navíc holé `next/server` → `next/server.js`. Robot publikace
 * (`src/app/api/play/_publish.ts`) ho táhne přes `_env.ts`; bundler příponu
 * doplní sám, holý Node ne.
 */

import { register } from 'node:module';

export async function resolve(specifier, context, next) {
  if (/^next\/[\w/-]+$/.test(specifier)) return next(`${specifier}.js`, context);
  return next(specifier, context);
}

// Jako `scripts/ts-paths.mjs`: načtený z kódu se zaregistruje jednou, jako hook už ne.
if (!process.env.VITEST && !process.env.P30C_LOADER_HOOK) {
  process.env.P30C_LOADER_HOOK = '1';
  await import('../../scripts/ts-paths.mjs');
  register(import.meta.url);
}
