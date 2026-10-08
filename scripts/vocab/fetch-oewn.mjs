#!/usr/bin/env node
/**
 * Stáhne Open English WordNet 2024 (P44C T4) do `D:/caches/oewn/`, ověří SHA-256 z `config.json`
 * a licenci, kterou vydání samo deklaruje (`<Lexicon license=…>` v XML; balík vydání soubor
 * LICENSE nemá). Jiná licence než CC-BY-4.0 nebo jiný hash = nenulový kód, nic dál se nestaví.
 *
 *   node scripts/vocab/fetch-oewn.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const { url, file, sha256, license } = config.oewn;

if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OEWN download failed: ${response.status} ${url}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

const bytes = readFileSync(file);
const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== sha256) {
  console.error(`OEWN SHA-256 mismatch: ${actual} != ${sha256} (${file})`);
  process.exit(1);
}

const head = gunzipSync(bytes).subarray(0, 4096).toString('utf8');
const declared = head.match(/<Lexicon\b[^>]*\blicense="([^"]+)"/)?.[1];
if (declared?.replace(/\/$/, '') !== license) {
  console.error(`OEWN license is ${declared ?? 'missing'}, expected ${license} (CC-BY-4.0)`);
  process.exit(1);
}
console.log(`OEWN 2024 ok: ${file} sha256 ${actual.slice(0, 12)}… license ${declared}`);
