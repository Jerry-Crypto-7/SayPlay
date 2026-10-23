#!/usr/bin/env node
/**
 * Kontrola produkční konfigurace před nasazením (P30A T6).
 *
 *   node scripts/cloud/check-env.mjs <soubor .env>
 *
 * Vrátí 1 a vypíše jméno proměnné (nikdy hodnotu – nese klíče), když:
 * - adresa (`*_ENDPOINT`, `*_URL`) míří na domácí PC nebo osobní předplatné:
 *   `trycloudflare.com`, `127.0.0.1`, `localhost`, `codex-cli`, `llamacpp:`,
 *   nebo na místní či soukromou adresu (`0.0.0.0`, `[::1]`, 10.x, 172.16–31.x, 192.168.x);
 * - chybí nebo je nečitelný dolarový strop `WORLDSMITH_SPEND_CAP_USD`
 *   či `WORLDSMITH_FALLBACK_SPEND_CAP_USD`;
 * - `WORLDSMITH_MODEL_PROFILE` není `api` / `metered` / prázdný – `subscription`
 *   je osobní předplatné a překlep upstream odmítne (demo by běželo bez režiséra);
 * - strop počtu volání (`WORLDSMITH_CALL_CAP`, `WORLDSMITH_FALLBACK_CALL_CAP`)
 *   chybí, nebo kousne dřív než dolarový strop: u gpt-oss-20b by výchozích 200
 *   volání skončilo po ~0,35 USD z 5 a každá další hra by byla návrh ze slov
 *   (revize T3, P30A T3a). Mez = strop / (max výstupních tokenů × cena výstupu);
 * - volitelný `PLAY_DIRECTOR_SLOTS` není celé číslo 1..2 (P53 T1);
 * - zapnutá čtečka (`PLAY_READER=on`) nemá dolarový strop a strop volání jako ostatní knihy,
 *   nebo nečte jen pro AI verzi (`PLAY_READER_PATH=ai`, P58B T3/T4).
 *
 * 0 = konfigurace nestojí na PC, 2 = chybí argument nebo soubor nejde přečíst.
 * Soubor je ve tvaru `vercel env pull`; vzor, který projde: `env.production.example`.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Co v adrese znamená domácí PC (tunel, místní služba) nebo předplatné (codex-cli, llama.cpp na 3090). */
const HOME_PC = ['trycloudflare.com', '127.0.0.1', 'localhost', 'codex-cli', 'llamacpp:'];
/** Místní a soukromé adresy (domácí síť), které z Vercelu nikdy nejsou vidět. */
const PRIVATE_HOST = /\/\/(0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
/** Tatáž jména jako `profileFrom()` v `src/server/upstream.ts`, bez `subscription`. */
const PROFILES = ['', 'api', 'metered'];

/** Primár a záloha: dolarový strop, počet volání, výstupní tokeny a cena výstupu za Mtok. */
const LEDGERS = [
  { cap: 'WORLDSMITH_SPEND_CAP_USD', calls: 'WORLDSMITH_CALL_CAP', tokens: 'WORLDSMITH_MAX_OUTPUT_TOKENS', price: 'WORLDSMITH_USD_PER_MTOK_OUT' },
  { cap: 'WORLDSMITH_FALLBACK_SPEND_CAP_USD', calls: 'WORLDSMITH_FALLBACK_CALL_CAP', tokens: 'WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS', price: 'WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT' },
];
/** `DEFAULT_MAX_OUTPUT_TOKENS` v `src/server/upstream.ts`; placená záloha má týž. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;

/**
 * `READER_MAX_OUTPUT_TOKENS` v `src/play/read/client.ts` – výstup čtení má pevný strop bez proměnné;
 * souhlas obou čísel hlídá `scripts/__tests__/cloud-check-env.test.ts`.
 */
export const READER_MAX_OUTPUT_TOKENS = 1024;
/** Kniha čtečky (`readerSpendCapFromEnv`), kontroluje se jen se zapnutou čtečkou (`PLAY_READER=on`). */
const READER_LEDGER = { cap: 'PLAY_READER_SPEND_CAP_USD', calls: 'PLAY_READER_CALL_CAP', tokens: '', price: 'PLAY_READER_USD_PER_MTOK_OUT', maxTokens: READER_MAX_OUTPUT_TOKENS };

/**
 * `MAX_PLAY_DIRECTOR_SLOTS` v `src/server/paid-slots.ts` (P53 T1); skript jede holým Nodem
 * a TypeScript neimportuje, souhlas obou čísel hlídá `scripts/__tests__/cloud-check-env.test.ts`.
 */
const MAX_PLAY_DIRECTOR_SLOTS = 2;

const isAddress = (name) => name.endsWith('_ENDPOINT') || name.endsWith('_URL');

/** Nezáporná částka, nebo `null` pro chybějící a nečitelnou hodnotu. */
function amount(raw) {
  const text = raw?.trim() ?? '';
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

/** Počet volání musí stačit na celý dolarový strop i v nejhorším případě každého volání. */
function callCapProblem(vars, { cap, calls, tokens, price, maxTokens: fixedTokens = DEFAULT_MAX_OUTPUT_TOKENS }) {
  const callCap = vars[calls]?.trim() ?? '';
  if (!/^\d+$/.test(callCap)) return { name: calls, reason: 'call cap missing or not a whole number' };
  const dollars = amount(vars[cap]);
  // Chybějící strop hlásí jeho vlastní kontrola; nulový strop nepustí žádné volání.
  if (dollars === null || dollars === 0) return null;
  const perMtok = amount(vars[price]);
  if (perMtok === null || perMtok === 0) return { name: price, reason: 'output price missing, the call cap cannot be checked against the dollar cap' };
  const maxTokens = amount(vars[tokens]) || fixedTokens;
  const needed = dollars / ((maxTokens * perMtok) / 1e6);
  return Number(callCap) < needed ? { name: calls, reason: `call cap bites before the dollar cap (needs at least ${String(Math.ceil(needed))})` } : null;
}

/** Proměnné, kvůli kterým nasazení neprojde, s důvodem; prázdné pole = v pořádku. */
export function checkEnv(vars) {
  const problems = [];
  for (const [name, value] of Object.entries(vars)) {
    if (!isAddress(name)) continue;
    const hit = HOME_PC.find((word) => value.toLowerCase().includes(word)) ?? PRIVATE_HOST.exec(value)?.[1];
    if (hit !== undefined) problems.push({ name, reason: `points at the home PC or the subscription (${hit})` });
  }
  const reader = vars.PLAY_READER?.trim() === 'on';
  const ledgers = reader ? [...LEDGERS, READER_LEDGER] : LEDGERS;
  for (const { cap } of ledgers) {
    if (amount(vars[cap]) === null) problems.push({ name: cap, reason: 'spend cap missing or not a dollar amount' });
  }
  // P58B T3: žádný změřený hostovaný model nečte pod 1 000 ms – na rychlé cestě by každé čtení vypršelo a stejně se zaplatilo.
  if (reader && vars.PLAY_READER_PATH?.trim() !== 'ai') problems.push({ name: 'PLAY_READER_PATH', reason: 'must be ai: no measured hosted reader fits the fast path (evals/play/p58b/README.md)' });
  const profile = vars.WORLDSMITH_MODEL_PROFILE?.trim().toLowerCase() ?? '';
  if (!PROFILES.includes(profile)) problems.push({ name: 'WORLDSMITH_MODEL_PROFILE', reason: 'must be metered or api, never the subscription' });
  for (const ledger of ledgers) {
    const problem = callCapProblem(vars, ledger);
    if (problem !== null) problems.push(problem);
  }
  // Volitelná: prázdná = 2. Hodnotu mimo mez by server zahodil a jel na 2, tady se to řekne dřív.
  const slots = vars.PLAY_DIRECTOR_SLOTS?.trim() ?? '';
  if (slots !== '' && !(/^\d+$/.test(slots) && Number(slots) >= 1 && Number(slots) <= MAX_PLAY_DIRECTOR_SLOTS)) {
    problems.push({ name: 'PLAY_DIRECTOR_SLOTS', reason: `must be a whole number from 1 to ${String(MAX_PLAY_DIRECTOR_SLOTS)}` });
  }
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
