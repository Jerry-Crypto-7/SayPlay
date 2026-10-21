/**
 * P56C T14: zapečetěná sada (40 vět nezávislého autora, T2) otevřená jednou – řetěz proti jedné hře téže věty.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p56c/holdout.measure.ts
 *
 * Druhé otevření odmítne `openSealedOnce` (`seal.ts`). Dokud ve stromu není rozhodnutí řetězu (T8) a slepý soudce
 * (T14), měření odmítne dřív, než sadu otevře: otevřená sada bez měření je spálená sada. Tělo měření doplní T14.
 * Věty se na výstup nevypisují, jen id.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { openSealedOnce, P56C_HOLDOUT_SHA256 } from './seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p56c');
/** Co musí ve stromu být, než se sada smí otevřít. */
const NEEDED = ['src/play/chain/decide.ts', 'src/play/chain/verify.ts', 'evals/play/p56c/judge.mjs'];

it('opens the sealed P56C holdout once (T14)', () => {
  const missing = NEEDED.filter((file) => !existsSync(join(process.cwd(), file)));
  if (missing.length > 0) throw new Error(`not ready to open the holdout (${missing.join(', ')} missing); opening it now would burn it`);
  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  openSealedOnce(DIR, P56C_HOLDOUT_SHA256, commit, 'P56C T14 (holdout.measure.ts)');
});
