import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Soubory, které modul `entry` načte za běhu – jen hodnotové importy, `import type` se vymaže. */
function valueImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const find = (from: string, spec: string): string | null => {
    const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
    if (base === null) return null;
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
    return null;
  };
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, clause, spec] of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)([^'"]*?)from\s+['"]([^'"]+)['"]/gms)) {
      const names = /^\{([^}]*)\}$/.exec(clause!.trim())?.[1];
      if (names !== undefined && names.split(',').every((name) => name.trim() === '' || name.trim().startsWith('type '))) continue;
      const next = find(file, spec!);
      if (next !== null) walk(next);
    }
  };
  walk(join(ROOT, entry));
  return new Set([...seen].map((file) => relative(ROOT, file).split('\\').join('/')));
}

describe('arkáda v prohlížeči nenese schémata GameSpec (P28E T5)', () => {
  it('ArcadePlay nenačte spec.ts ani registr mechanik', () => {
    // Na emulovaném telefonu jejich stavba při startu stála ~0,25 s prvního snímku.
    const loaded = valueImports('src/components/play/arcade/ArcadePlay.tsx');
    expect(loaded.has('src/play/arcade/addons.ts')).toBe(true);
    expect([...loaded].filter((file) => ['src/play/spec.ts', 'src/play/registry.ts', 'src/ir/worlddoc.ts'].includes(file))).toEqual([]);
  });
});
