import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CSS_OUT, FONT_STACK, TS_OUT, readSource, renderCss, renderTs } from '../../../scripts/brand/tokens.mjs';
import { color, colorHex, typography } from '../tokens';

/**
 * Vygenerované tokeny, které se tiše rozejdou s `tokens.json` z kitu, na pohled
 * nikdo nepozná: barva o dva odstíny vedle vypadá pořád „jako kit". Test je
 * vygeneruje znovu a porovná s tím, co leží na disku.
 */

const ROOT = process.cwd();
const source = readSource(ROOT);

/** Odstín ve stupních, `null` pro šedou (bez sytosti odstín nemá smysl). */
function hue(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('brand tokens', () => {
  it('tokens.css and tokens.ts match a fresh render of tokens.json', () => {
    expect(readFileSync(join(ROOT, CSS_OUT), 'utf8')).toBe(renderCss(source));
    expect(readFileSync(join(ROOT, TS_OUT), 'utf8')).toBe(renderTs(source));
  });

  it('has no purple: no palette hue between 250 and 320 degrees', () => {
    const purple = Object.entries(color).filter(([, hex]) => {
      const h = hue(hex);
      return h !== null && h >= 250 && h <= 320;
    });
    expect(purple).toEqual([]);
  });

  it('exports the numeric tomato for three.js', () => {
    expect(colorHex.tomato).toBe(0xff5a36);
  });

  it('sets both font families to Roboto and maps the weights to real cuts', () => {
    expect(renderCss(source)).toContain(`--sp-font-display: ${FONT_STACK};`);
    expect(FONT_STACK.startsWith("'Roboto', system-ui")).toBe(true);
    const weights = new Set(Object.values(typography).map((t) => t.weight));
    expect([...weights].sort()).toEqual([500, 700, 900]);
    expect(typography['display-l'].weight).toBe(900);
  });
});
