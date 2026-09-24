/**
 * Zavaděč pro skripty, které holým Nodem (`--experimental-strip-types`) čtou
 * moduly aplikace: doplní cestu `@/` → `src/`, příponu `.ts` / `/index.ts`,
 * kterou kód aplikace nepíše (řeší ji bundler), a atribut `json` u importu
 * JSON. Zapíná se `--import ./scripts/ts-paths.mjs`, nebo z kódu `register()`.
 */

import { existsSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const file = (path) => existsSync(path) && statSync(path).isFile();

/** Soubor za cestou bez přípony, jak ho najde bundler. */
function complete(path) {
  if (file(path)) return path;
  for (const candidate of [`${path}.ts`, `${path}.tsx`, join(path, 'index.ts')]) if (file(candidate)) return candidate;
  return null;
}

export async function resolve(specifier, context, next) {
  const local = specifier.startsWith('@/') ? join(SRC, specifier.slice(2)) : (specifier.startsWith('.') && context.parentURL?.startsWith('file:') ? resolvePath(dirname(fileURLToPath(context.parentURL)), specifier) : null);
  if (local !== null) {
    const found = complete(local);
    if (found !== null) return next(pathToFileURL(found).href, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  return next(url, url.endsWith('.json') ? { ...context, importAttributes: { ...context.importAttributes, type: 'json' } } : context);
}

// Načtený přes `--import` se zavaděč zaregistruje sám; jako hook (`register`) už ne.
if (!process.env.TS_PATHS_HOOK) {
  process.env.TS_PATHS_HOOK = '1';
  register(import.meta.url);
}
