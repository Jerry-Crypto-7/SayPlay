/**
 * Pečeť zapečetěné sady P58B (T1): sada se otevře jednou, v T8. Logika je pečeť P55 (`openSealedOnce` bere složku
 * a otisk, `sha256Lf` počítá nad LF bajty); tady jen otisk P58B.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { openSealedOnce, sha256Lf } from '../p55/seal';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P58B_HOLDOUT_SHA256 = '578463714c9cee6540eb7c4755a68ecfbb883905388ad741c3f0648058c117e8';

const PLAY = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Věty sady (`evals/play/<set>`), je-li soubor sadou vět (pole `{ text }` nebo `{ sentences: [{ text }] }`); jinak nic. */
export const textsOf = (set: string): string[] => {
  const json = JSON.parse(readFileSync(join(PLAY, set), 'utf8')) as unknown;
  const rows = Array.isArray(json) ? json : (json as { sentences?: unknown }).sentences;
  return Array.isArray(rows) && rows.every((row) => typeof (row as { text?: unknown }).text === 'string') ? rows.map((row) => (row as { text: string }).text) : [];
};

/** Každá sada vět ve složkách, které plán jmenuje (p58a až po sloučení P58A); prázdné soubory výsledků se nepočítají. */
const SCANNED_DIRS = ['p30', 'p55', 'p56a', 'p58a'] as const;
/** Další sady, na kterých se ladilo nebo které kdo otevřel (seznam P56A). */
const OTHER_SETS = ['p43/panel.json', 'p43/sealed-100.json', 'p45/panel.json', 'p45/sealed-100.json', 'p52/dev.json', 'p52/holdout.json', 'p54c/dev.json', 'p54c/holdout.json', 'demand/corpus.json'] as const;

/** Sady vět mimo zapečetěnou P58B (cesty od `evals/play`), se kterými nic nového nesmí sdílet větu. */
export const knownSets = (): string[] => [
  ...SCANNED_DIRS.flatMap((dir) => (existsSync(join(PLAY, dir)) ? readdirSync(join(PLAY, dir)).filter((name) => name.endsWith('.json')).map((name) => `${dir}/${name}`) : [])),
  ...OTHER_SETS,
].filter((set) => textsOf(set).length > 0);
