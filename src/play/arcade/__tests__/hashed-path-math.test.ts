import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Na hashované cestě smí být jen přesně zaokrouhlená matematika: `Math.sqrt` je podle
// IEEE 754 přesná v každém prohlížeči, `Math.hypot` ne – poslední bit se mezi enginy
// liší a rozbije přehrání ducha i Dare (nález 8 review P42).
const HASHED = ['src/play/arcade/pieces/assembly-parts.ts'];

describe('hashed path math', () => {
  it.each(HASHED)('%s uses no Math.hypot', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const lines = source.split('\n').flatMap((line, index) => (/Math\.hypot\s*\(/.test(line) ? [`${file}:${index + 1}`] : []));
    expect(lines).toEqual([]);
  });
});
