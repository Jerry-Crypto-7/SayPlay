/**
 * Jediná cesta, kterou měřidlo P44C čte zapečetěnou sadu (`sealed-110.json`).
 *
 * Bez `--open-sealed-once` odmítne. S ním zapíše `sealed-opened.json` (čas, commit, SHA sady)
 * s `flag: 'wx'`, takže druhé otevření skončí chybou – číslo ze sady vznikne jednou.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const SEALED = 'evals/play/p44c/sealed-110.json';
export const OPENED = 'evals/play/p44c/sealed-opened.json';

export function openSealedOnce(argv: readonly string[], paths = { sealed: SEALED, opened: OPENED }): unknown {
  if (!argv.includes('--open-sealed-once')) throw new Error('P44C sealed set opens only with --open-sealed-once');
  const bytes = readFileSync(paths.sealed);
  const record = {
    openedAtUtc: new Date().toISOString(),
    commit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeFileSync(paths.opened, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return JSON.parse(bytes.toString('utf8'));
}
