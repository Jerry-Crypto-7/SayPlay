#!/usr/bin/env node
/**
 * Změří, kolik podstatných jmen rolí z vět dostane přesný model katalogu – před
 * CC0 modely a teď (P26A T7).
 *
 *   node scripts/assets/cc0/coverage.mjs      zapíše evals/play/catalog-coverage.json
 *
 * Měří se přes `modelOf` z `src/play/arcade/models.ts` – TypeScript s aliasem
 * `@/`, takže výpočet běží pod vitestem (`evals/play/catalog-coverage.measure.ts`).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const vitest = path.join(ROOT, 'node_modules/vitest/vitest.mjs');
const run = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.measure.mts', 'evals/play/catalog-coverage.measure.ts'], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
