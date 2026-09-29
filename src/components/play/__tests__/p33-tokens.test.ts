import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Stupnice P33 (T2): nová ruční velikost písma nebo průhlednost vypadá na
 * snímku dobře a tiše rozbije stupnici. Tenhle test ji drží na pravidlech
 * `play.css`, která patří P33 – bloky `/* P32… *\/` jsou jiné stopy.
 */

const CSS = readFileSync(join(process.cwd(), 'src/app/play/play.css'), 'utf-8');

/** Pravidla bez bloků P32: od komentáře `/* P32…` do dalšího `/* P…` bloku, který není P32, nebo do konce. */
function ownRules(css: string): string {
  return css.replace(/\/\* P32[\s\S]*?(?=\/\* P(?!32)|$)/g, '');
}

/** Deklarace `vlastnost: hodnota` mimo definice vlastních proměnných (`--…`). */
function declarations(css: string): { property: string; value: string }[] {
  const found: { property: string; value: string }[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/(?<=[{;\s])([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const [, property, value] = match;
    if (property.startsWith('--')) continue;
    found.push({ property, value: value.trim() });
  }
  return found;
}

const TOKEN = /^var\(--p-text-(xs|s|m|l|xl)\)$/;
const CLAMP = /^clamp\(var\(--p-text-(xs|s|m|l|xl)\),\s*[^,]+,\s*var\(--p-text-(xs|s|m|l|xl)\)\)$/;

describe('play.css – P33 design tokens', () => {
  const own = declarations(ownRules(CSS));

  it('defines the spacing, radius, type, surface, shadow and tap tokens', () => {
    for (let step = 1; step <= 8; step += 1) expect(CSS).toMatch(new RegExp(`--p-space-${String(step)}:\\s*${String(step * 4)}px;`));
    for (const name of ['--p-radius-s', '--p-radius-m', '--p-radius-l', '--p-surface-1', '--p-surface-2', '--p-surface-3', '--p-shadow-1', '--p-shadow-2']) {
      expect(CSS).toContain(`${name}:`);
    }
    for (const size of ['xs', 's', 'm', 'l', 'xl']) expect(CSS).toContain(`--p-text-${size}:`);
    expect(CSS).toMatch(/--p-tap:\s*44px;/);
  });

  it('puts the P33 block right after the palette, before any older rule', () => {
    const block = CSS.indexOf('/* P33 */');
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThan(CSS.indexOf('.play-create'));
  });

  it('uses only the five-step scale for font sizes', () => {
    const off = own.filter((d) => d.property === 'font-size' && !TOKEN.test(d.value) && !CLAMP.test(d.value));
    expect(off.map((d) => d.value)).toEqual([]);
  });

  it('keeps hand-written transparency to at most three', () => {
    const loose = own.filter((d) => /rgba\(|rgb\([^)]*\//.test(d.value));
    expect(loose.length, loose.map((d) => `${d.property}: ${d.value}`).join('\n')).toBeLessThanOrEqual(3);
    expect(own.filter((d) => /rgba?\(\s*15[\s,]+23[\s,]+42/.test(d.value))).toEqual([]);
  });

  it('gives every button and chip the 44 px tap height', () => {
    for (const selector of ['.play-button', '.play-chip', '.play-target', '.play-starter', '.play-pager-step']) {
      const rule = new RegExp(`(^|[\\s,}])${selector.replace('.', '\\.')}\\s*[,{][^}]*min-height:\\s*var\\(--p-tap\\)`, 'm');
      const grouped = new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{[^}]*min-height:\\s*var\\(--p-tap\\)`);
      expect(rule.test(CSS) || grouped.test(CSS), `${selector} has no min-height: var(--p-tap)`).toBe(true);
    }
  });
});
