#!/usr/bin/env node
/**
 * Kontrola produkční konfigurace před nasazením (P30A T6).
 *
 *   node scripts/cloud/check-env.mjs <soubor .env>
 *
 * Vrátí 1 a vypíše jméno proměnné (nikdy hodnotu – nese klíče), když:
 * - adresa (`*_ENDPOINT`, `*_URL`) míří na domácí PC nebo osobní předplatné:
 *   `trycloudflare.com`, `127.0.0.1`, `localhost`, `codex-cli`, `llamacpp:`;
 * - chybí nebo je nečitelný dolarový strop `WORLDSMITH_SPEND_CAP_USD`
 *   či `WORLDSMITH_FALLBACK_SPEND_CAP_USD`;
 * - `WORLDSMITH_MODEL_PROFILE` není `api` / `metered` / prázdný – `subscription`
 *   je osobní předplatné a překlep upstream odmítne (demo by běželo bez režiséra).
 *
 * 0 = konfigurace nestojí na PC, 2 = chybí argument nebo soubor nejde přečíst.
 * Soubor je ve tvaru `vercel env pull`; vzor, který projde: `env.production.example`.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Co v adrese znamená domácí PC (tunel, místní služba) nebo předplatné (codex-cli, llama.cpp na 3090). */
const HOME_PC = ['trycloudflare.com', '127.0.0.1', 'localhost', 'codex-cli', 'llamacpp:'];
const CAPS = ['WORLDSMITH_SPEND_CAP_USD', 'WORLDSMITH_FALLBACK_SPEND_CAP_USD'];
/** Tatáž jména jako `profileFrom()` v `src/server/upstream.ts`, bez `subscription`. */
const PROFILES = ['', 'api', 'metered'];

const isAddress = (name) => name.endsWith('_ENDPOINT') || name.endsWith('_URL');

/** Proměnné, kvůli kterým nasazení neprojde, s důvodem; prázdné pole = v pořádku. */
export function checkEnv(vars) {
  const problems = [];
  for (const [name, value] of Object.entries(vars)) {
    if (!isAddress(name)) continue;
    const hit = HOME_PC.find((word) => value.toLowerCase().includes(word));
    if (hit !== undefined) problems.push({ name, reason: `points at the home PC or the subscription (${hit})` });
  }
  for (const name of CAPS) {
    const raw = vars[name]?.trim() ?? '';
    if (raw === '' || !/^\d+(\.\d+)?$/.test(raw)) problems.push({ name, reason: 'spend cap missing or not a dollar amount' });
  }
  const profile = vars.WORLDSMITH_MODEL_PROFILE?.trim().toLowerCase() ?? '';
  if (!PROFILES.includes(profile)) problems.push({ name: 'WORLDSMITH_MODEL_PROFILE', reason: 'must be metered or api, never the subscription' });
  return problems;
}

/** Řádky `KLÍČ=hodnota` jako z `vercel env pull`: `export`, uvozovky, komentáře, prázdné hodnoty. */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    const [, name, raw] = match;
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    vars[name] = quoted === null ? raw.replace(/\s+#.*$/, '') : quoted[2];
  }
  return vars;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('usage: node scripts/cloud/check-env.mjs <env file>');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const problems = checkEnv(parseEnvFile(text));
  for (const { name, reason } of problems) console.error(`${name}: ${reason}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${file}: production config does not depend on the home PC`);
}
