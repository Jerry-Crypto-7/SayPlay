/**
 * Nástroj dosažitelnosti (`scripts/legacy-reach.mjs`): co `/play` tranzitivně
 * importuje, nesmí vyjít jako smazatelné. Hlídá přesně ty tvary importu, které
 * regex snadno přehlédne – alias `@/`, re-export, `import()` uvnitř `dynamic`,
 * `require` JSONu – a to, že test není vstupní bod ani důvod ponechání.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyze, check, why } from '../legacy-reach.mjs';

let root = '';

function put(path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-reach-'));
  put(
    'src/app/play/page.tsx',
    [
      "import x from '@/a';",
      "export { y } from '../../b';",
      "const C = dynamic(() => import('../../c'));",
      "const d = require('../../d.json');",
      'export default function Page() { return x + C + d; }',
    ].join('\n'),
  );
  // `src/app/play/**` je vstup v každé hloubce, ne jen o úroveň níž.
  put('src/app/play/[id]/share/page.tsx', "import { deep } from '@/nested/deep';\nexport default deep;");
  put('src/nested/deep.ts', 'export const deep = 4;');
  put('src/a.ts', "/**\n * Dřív to dělal `src/g.ts`, viz import from '@/g'.\n */\n// require('./f')\nexport default 1;");
  put('src/b.ts', "import './nested/b2';\nexport const y = 2;");
  put('src/nested/b2.ts', 'export {};');
  put('src/c.tsx', 'export default function C() { return null; }');
  put('src/d.json', '{}');
  // Nikdo z produktu je neimportuje, jen test – test je nesmí udržet naživu.
  put('src/__tests__/e.test.ts', "import { f } from '@/f';\nimport { g } from '../g';\n");
  put('src/f.ts', "import { g } from './g';\nexport const f = g;");
  put('src/g.ts', 'export const g = 3;');
  put('src/__tests__/a.test.ts', "import a from '@/a';\n");
  put('src/__tests__/mixed.test.ts', "import a from '@/a';\nimport { g } from '@/g';\n");
  // Skript volaný z package.json je vstupní bod; .d.mts k němu patří.
  put('package.json', JSON.stringify({ scripts: { gate: 'node scripts/gate.mjs --sync' } }));
  put('scripts/gate.mjs', "import { h } from './lib/h.mjs';\n");
  put('scripts/gate.d.mts', 'export {};');
  put('scripts/lib/h.mjs', 'export const h = 1;');
  put('scripts/old.mjs', "import { h } from './lib/h.mjs';\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('analyze', () => {
  it('follows the @/ alias, re-exports, import() and require of JSON', () => {
    const result = analyze(root);
    for (const file of ['src/a.ts', 'src/b.ts', 'src/nested/b2.ts', 'src/c.tsx', 'src/d.json', 'src/nested/deep.ts'])
      expect(result.reachable.has(file), file).toBe(true);
  });

  it('never counts a test as an entry point or as a reason to keep a file', () => {
    const result = analyze(root);
    expect(result.reachable.has('src/f.ts')).toBe(false);
    expect(result.reachable.has('src/g.ts')).toBe(false);
    expect(result.deletable).toEqual(expect.arrayContaining(['src/f.ts', 'src/g.ts', 'scripts/old.mjs']));
    expect(result.deletable).not.toContain('src/a.ts');
    expect(result.tests.deletable).toEqual(['src/__tests__/e.test.ts']);
    expect(result.tests.kept).toEqual(['src/__tests__/a.test.ts']);
    expect(result.tests.mixed).toEqual(['src/__tests__/mixed.test.ts']);
  });

  it('takes scripts named in package.json as entry points with their .d.mts', () => {
    const result = analyze(root);
    for (const file of ['scripts/gate.mjs', 'scripts/gate.d.mts', 'scripts/lib/h.mjs'])
      expect(result.reachable.has(file), file).toBe(true);
  });

  it('treats an excluded file as gone', () => {
    const result = analyze(root, { exclude: /^src\/b\.ts$/ });
    expect(result.reachable.has('src/nested/b2.ts')).toBe(false);
  });
});

describe('why', () => {
  it('prints the import path from an entry point', () => {
    expect(why(analyze(root), 'src/nested/b2.ts')).toEqual(['src/app/play/page.tsx', 'src/b.ts', 'src/nested/b2.ts']);
    expect(why(analyze(root), 'src/g.ts')).toBeNull();
  });
});

describe('check', () => {
  it('passes when only unreachable files and their tests are gone', () => {
    for (const file of ['src/f.ts', 'src/__tests__/e.test.ts']) rmSync(join(root, file));
    expect(check(root, { deleted: ['src/f.ts', 'src/__tests__/e.test.ts'] }).problems).toEqual([]);
  });

  it('fails when a reachable file or an entry point is gone', () => {
    rmSync(join(root, 'src/c.tsx'));
    rmSync(join(root, 'src/app/play/page.tsx'));
    const { problems } = check(root, { deleted: ['src/c.tsx', 'src/app/play/page.tsx'] });
    expect(problems).toEqual(['src/app/play/page.tsx is an entry point']);
  });

  it('fails when a kept file still imports a deleted one', () => {
    rmSync(join(root, 'src/g.ts'));
    const { problems } = check(root, { deleted: ['src/g.ts'] });
    expect(problems).toEqual([
      'src/__tests__/e.test.ts imports deleted src/g.ts',
      'src/__tests__/mixed.test.ts imports deleted src/g.ts',
      'src/f.ts imports deleted src/g.ts',
    ]);
  });
});
