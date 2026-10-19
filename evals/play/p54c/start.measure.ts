/**
 * Výchozí stav P54C (T1): co nové žánry nesmějí pohnout. Věty P30 dev →
 * klasifikátor (`classifyGenre`, bez čtení modelem) a žánr návrhu na semínku 1,
 * živé buňky, grep determinismu a výsledek replay brány.
 *
 * ```
 * npx vitest run <replay brána> --reporter=json --outputFile.json=<f>
 * P54C_REPLAY_JSON=<f> P54C_HEAD=<sha> npx vitest run --config vitest.measure.mts evals/play/p54c/start.measure.ts
 * ```
 *
 * `P54C_CHECK=1` nic nepíše a jen porovná věty a buňky se zapsaným `start.json`
 * (důkaz „nic se nepohnulo“ v T4).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { loadRapier } from '../../../src/play/arcade/physics/world';
import { liveCells } from '../../../src/play/compose/allowed';

import { rowOf, type Row } from './rows';

const DIR = join(process.cwd(), 'evals', 'play', 'p54c');
const OUT = join(DIR, 'start.json');
const DETERMINISM = /Math\.random|Date\.now|performance\.now/;

/** `grep -rnE "Math\.random|Date\.now|performance\.now"` nad třemi stromy jádra, cesty s `/`. */
function determinismGrep(): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (DETERMINISM.test(line)) hits.push(`${path.slice(process.cwd().length + 1).replace(/\\/g, '/')}:${index + 1}`);
      });
    }
  };
  for (const root of ['src/play/arcade', 'src/play/compose', 'src/play/genre']) walk(join(process.cwd(), root));
  return hits;
}

function replayGate(): { readonly passed: number; readonly failed: number; readonly files: number; readonly success: boolean } | null {
  const path = process.env.P54C_REPLAY_JSON;
  if (path === undefined || !existsSync(path)) return null;
  const run = JSON.parse(readFileSync(path, 'utf8')) as { numPassedTests: number; numFailedTests: number; testResults: unknown[]; success: boolean };
  return { passed: run.numPassedTests, failed: run.numFailedTests, files: run.testResults.length, success: run.success };
}

it('records the P54C starting state', async () => {
  await loadRapier();
  const dev = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p30', 'dev.json'), 'utf8')) as { sentences: { id: string; text: string }[] };
  const rows: Row[] = dev.sentences.map(({ id, text }) => rowOf(id, text));
  const live = liveCells().map(cell => cell.id);

  if (process.env.P54C_CHECK === '1') {
    const start = JSON.parse(readFileSync(OUT, 'utf8')) as { sentences: Row[]; liveCells: { ids: string[] } };
    expect(rows).toEqual(start.sentences);
    expect(live).toEqual(start.liveCells.ids);
    return;
  }
  writeFileSync(OUT, `${JSON.stringify({
    schema: 'p54c-start.v1',
    originMain: process.env.P54C_HEAD ?? null,
    replayGate: replayGate(),
    determinismGrep: determinismGrep(),
    liveCells: { count: live.length, ids: live },
    sentences: rows,
  }, null, 1)}\n`);
}, 600_000);
