/**
 * Dosah změny klasifikátoru (P54C T13): každá věta repa → žánry se skóre podle `classifyGenre` (bez čtení
 * modelem). Dva běhy – před změnou a po ní – a rozdíl řekne, které věty mimo měřené sady změnily první žánr
 * a který test je může držet (T13 tak našel věty P51, P52 a P46A).
 *
 * ```
 * P54C_SCAN_OUT=<soubor.json> npx vitest run --config vitest.measure.mts evals/play/p54c/scan.measure.ts
 * ```
 *
 * Věty bere z řetězců JSON v `evals/`, `src/` a `e2e/` (soubory do 1,5 MB) a z řetězců testů a měřidel.
 * Sealované sady (`holdout`, `test-200`) nečte – soubor s takovým jménem přeskočí dřív, než ho otevře.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

import { classifyGenre } from '../../../src/play/genre/classify';

const ROOT = process.cwd();
const SEALED = /holdout|test-200|sealed/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
}

it('scans every sentence of the repo through the classifier', () => {
  const files: string[] = [];
  for (const root of ['evals', 'src', 'e2e']) walk(join(ROOT, root), files);
  const texts = new Set<string>();
  for (const file of files) {
    if (SEALED.test(file) || statSync(file).size > 1_500_000) continue;
    if (file.endsWith('.json')) {
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const visit = (value: unknown): void => {
        if (typeof value === 'string') {
          if (/^[A-Za-z][^\n]{6,300}$/.test(value) && value.includes(' ')) texts.add(value);
        } else if (Array.isArray(value)) value.forEach(visit);
        else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
      };
      visit(data);
    } else if (file.endsWith('.ts') && /\.(?:test|spec|measure)\.ts$|__tests__/.test(file)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(['"`])((?:(?!\1)[^\\\n]){8,300})\1/g)) {
        const value = match[2]!;
        if (/^[A-Za-z][a-zA-Z' ,.!?-]+$/.test(value) && value.split(' ').length >= 3) texts.add(value);
      }
    }
  }
  const rows: Record<string, string> = {};
  for (const text of [...texts].sort()) {
    const ranking = classifyGenre(text, null);
    const first = ranking.ranked[0]!;
    rows[text] = ranking.ranked.filter((choice) => choice.score > 0).map((choice) => `${choice.genre}.${choice.mode}:${choice.score}`).join(' ') || `none:${first.genre}.${first.mode}`;
  }
  writeFileSync(process.env.P54C_SCAN_OUT ?? join(tmpdir(), 'p54c-scan.json'), JSON.stringify(rows, null, 1));
}, 600_000);
