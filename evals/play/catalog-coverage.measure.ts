/**
 * Zapíše `catalog-coverage.json` (P26A T7, T12). Spouští ho
 * `node scripts/assets/cc0/coverage.mjs`; výpočet je v `catalog-coverage.ts`,
 * protože `modelOf` arkády je TypeScript s aliasem `@/`, který holý `node` nenačte.
 *
 * Tři stavy katalogu (T12): dnešní `modelOf` nad katalogem z gitu – větev
 * `7c411db` (poslední `features/p26-f1` před CC0, index z jeho `catalog.json`), commit po T7 a teď.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it, vi } from 'vitest';

import { catalogIndex } from '../../scripts/assets/cc0/promote.mjs';
import { measureCoverage, stateOf } from './catalog-coverage';

const show = (ref: string, file: string) => JSON.parse(execFileSync('git', ['--no-replace-objects', 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

const STATES = [
  { name: 'before-CC0 (7c411db)', index: () => catalogIndex(show('7c411db', 'src/assets/catalog.json')) },
  { name: 'after-T7 (e0aa52c)', index: () => show('e0aa52c', 'src/assets/catalog-index.json') },
];

async function stateAt(index: unknown) {
  vi.resetModules();
  vi.doMock('@/assets/catalog-index.json', () => ({ default: index }));
  const measure = await import('./catalog-coverage');
  const state = measure.stateOf(measure.measureCoverage());
  vi.doUnmock('@/assets/catalog-index.json');
  return state;
}

it('writes evals/play/catalog-coverage.json', async () => {
  const coverage = measureCoverage();
  const states: Record<string, ReturnType<typeof stateOf>> = {};
  for (const state of STATES) states[state.name] = await stateAt(state.index());
  states.now = stateOf(coverage);
  writeFileSync(fileURLToPath(new URL('./catalog-coverage.json', import.meta.url)), `${JSON.stringify({ ...coverage, states }, null, 2)}\n`);
  for (const [name, state] of Object.entries(states)) {
    console.log(`${name}: ${state.models} models, nouns ${state.nouns.now}/${state.nouns.distinct}, mentions ${state.mentions.now}/${state.mentions.mentions}, hostile ${state.bySet.hostile.now}/${state.bySet.hostile.mentions}`);
  }
}, 120_000);
