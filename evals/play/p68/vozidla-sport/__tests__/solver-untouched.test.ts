/**
 * P68V T1: pruh nemění sdílené nastavení solveru (podkroky, iterace, tření, gravitace) ani jádro. Srovnává se
 * s místem, kde větev odbočila z `origin/main` (merge-base) – když `origin/main` sám soubor změní, není to vina pruhu.
 * Kontrolní případ dokazuje, že tentýž příkaz změnu vidí: `step.ts` se liší od rodiče commitu, který ho naposled měnil.
 */

import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SOLVER = ['src/play/arcade/physics', 'src/play/arcade/contract.ts', 'src/play/arcade/kernel.ts'];

const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

/** `true` = soubory se od `base` liší (pracovní strom proti commitu). */
function changedSince(base: string, paths: readonly string[]): boolean {
  const diff = git(['diff', '--quiet', base, '--', ...paths]);
  if (diff.status !== 0 && diff.status !== 1) throw new Error(`git diff failed: ${diff.stderr}`);
  return diff.status === 1;
}

function rev(args: string[]): string {
  const out = git(args);
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

describe('P68V solver untouched', () => {
  it('physics, the arcade contract and the kernel equal the merge base with origin/main', () => {
    const base = rev(['merge-base', 'HEAD', 'origin/main']);
    expect(changedSince(base, SOLVER)).toBe(false);
  });

  it('the same check sees a real change', () => {
    const last = rev(['log', '-1', '--format=%H', '--', 'src/play/arcade/physics/step.ts']);
    expect(changedSince(`${last}^`, ['src/play/arcade/physics/step.ts'])).toBe(true);
  });
});
