/**
 * Pečeť zapečetěné sady P55 (T2): sada se otevře jednou. Před prvním čtením vět se zapíše `holdout-opened.json`
 * (otisk, commit, čas); existuje-li, otevření odmítne – sada otevřená dvakrát je dev sada a její číslo už nic
 * neříká. Otisk = SHA-256 nad LF bajty.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při zapečetění. */
export const P55_HOLDOUT_SHA256 = '7ee816ac289a957e17fb706956aa98c4ab6ce404b3c282cd296fca6c1bfe0537';

/** Osm žánrů P54C v pořadí sady; první čtyři jsou pruhové. */
export const P55_GENRES = ['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push'] as const;
export const P55_LANE_GENRES = ['catch', 'whack', 'defense', 'slice'] as const;

export const sha256Lf = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

/** Otevře `holdout.json` v `dir` jednou: ověří otisk, zapíše záznam otevření a vrátí LF obsah. */
export function openSealedOnce(dir: string, sha256: string, commit: string, by: string): string {
  const opened = join(dir, 'holdout-opened.json');
  if (existsSync(opened)) throw new Error(`holdout-opened.json exists in ${dir} – the holdout was already opened; a second run would make it a dev set`);
  const bytes = readFileSync(join(dir, 'holdout.json'), 'utf8').replace(/\r\n/g, '\n');
  const sha = sha256Lf(bytes);
  if (sha !== sha256) throw new Error(`holdout.json SHA-256 ${sha} is not the sealed ${sha256}`);
  writeFileSync(opened, `${JSON.stringify({ schema: 'p55-holdout-opened.v1', sha256: sha, openedAt: new Date().toISOString(), commit, by, note: 'Opened once for the final report; nothing is tuned on it.' }, null, 1)}\n`);
  return bytes;
}
