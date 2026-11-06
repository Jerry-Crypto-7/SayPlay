/**
 * Export pro nasazení (P71A T6): vypsaný příkaz se kopíruje do shellu a nese
 * strom, který pak `/api/build-id` vrátí. Špatný strom nebo ref, který git či
 * shell vezme jako přepínač, by vypadal v pořádku a nasadil by něco jiného.
 */

import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { deployCommand, refProblem } from '../cloud/export-for-deploy.mjs';

const SCRIPT = 'scripts/cloud/export-for-deploy.mjs';
const TREE = '0123456789abcdef0123456789abcdef01234567';

describe('deployCommand', () => {
  it('nese strom do buildu a nasazuje produkci bez dotazu', () => {
    expect(deployCommand(TREE)).toBe(`vercel deploy --prod --yes --build-env WORLDSMITH_BUILD_TREE=${TREE}`);
  });

  it('odmítne strom, který není 40 znaků hex', () => {
    expect(() => deployCommand('unbuilt')).toThrow();
    expect(() => deployCommand(`${TREE}; rm -rf /`)).toThrow();
  });
});

describe('refProblem', () => {
  it.each(['origin/main', 'HEAD', 'v1.0-submission', 'features/P71A-x', 'HEAD~1', TREE])('pustí %s', (ref) => {
    expect(refProblem(ref)).toBeNull();
  });

  it.each(['', '--output=/tmp/x', '-o', 'main; vercel deploy', 'main..HEAD', 'HEAD@{1}', 'a b', '$(id)'])(
    'odmítne „%s“',
    (ref) => {
      expect(refProblem(ref)).not.toBeNull();
    },
  );
});

describe('CLI', () => {
  it('ref s přepínačem skončí 2 a nic neexportuje', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--output=x'], { encoding: 'utf-8' });
    expect(run.status).toBe(2);
    expect(run.stdout).not.toContain('export ');
  });

  it('ref, který neukazuje na commit, skončí 2', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'no-such-ref-p71a'], { encoding: 'utf-8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('neukazuje na commit');
  });
});
