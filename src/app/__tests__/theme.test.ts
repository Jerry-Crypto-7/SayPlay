import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SCENE_ROLES, UI_TOKENS, UI_TOKENS_CVD } from '../../kit/palettes';

/**
 * Téma je na dvou místech — `UI_TOKENS` v kitu a CSS proměnné v `theme.css` —
 * a jinak to nejde: CSS proměnnou z TypeScriptu bez běhového zápisu do `<style>`
 * neuděláš a ten by při každém načtení blikl nenastylovaným HUD. Tenhle soubor
 * je tedy jediné, co obě kopie drží u sebe.
 *
 * Druhá polovina je pravidlo o odstínech. Je psané jako **pásmo odstínu**, ne
 * jako seznam zakázaných jmen a hexů: seznam by musel ta jména obsahovat, čímž
 * by sám shodil kontrolu z AC, která je po `src` a `public` hledá.
 */

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'src/app/theme.css'), 'utf-8');

/** Odstín 0–360 ze sRGB hexu. Šedé vrací `null` — jejich odstín nic neznamená. */
function hueOf(hex: string): number | null {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return null;

  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;

  return (((hue * 60) % 360) + 360) % 360;
}

/**
 * Proměnné `--ws-*` z jednoho selektoru.
 *
 * Hledá se přes `indexOf`, ne přes regulární výraz složený z řetězce: uvnitř
 * šablonového literálu se `\s` a `\{` zkrátí na `s` a `{` a výraz pak tiše
 * nenajde nic. Stálo to jedno kolo.
 */
function variablesOf(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector);
  expect(at, `v theme.css chybí selektor ${selector}`).toBeGreaterThanOrEqual(0);

  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);

  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--ws-([a-z-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

describe('téma sedí s tokeny kitu', () => {
  const root = variablesOf(':root');
  const cvd = variablesOf(":root[data-palette='cvd']");

  it.each(Object.entries(UI_TOKENS))('--ws-%s je %s', (token, hex) => {
    expect(root[token]).toBe(hex);
  });

  it('CSS nepřidává barevný token, který kit nezná', () => {
    // Bez tohohle by se dala barva zavést jen v CSS a `UI_TOKENS` by přestaly
    // být zdrojem — byly by jen jednou z kopií.
    const colorLike = Object.keys(root).filter((name) => /^#|^rgb/.test(root[name]));
    expect(colorLike.sort()).toEqual(Object.keys(UI_TOKENS).sort());
  });

  it('varianta pro barvoslepé mění právě dvojici výhra/prohra', () => {
    expect(Object.keys(cvd).sort()).toEqual(['negative', 'positive']);
    expect(cvd.positive).toBe(UI_TOKENS_CVD.positive);
    expect(cvd.negative).toBe(UI_TOKENS_CVD.negative);
  });

  it('varianta se od základní opravdu liší', () => {
    // Kdyby se rovnaly, byl by přepínač dekorace a test výš by prošel taky.
    expect(UI_TOKENS_CVD.positive).not.toBe(UI_TOKENS.positive);
    expect(UI_TOKENS_CVD.negative).not.toBe(UI_TOKENS.negative);
  });

  it('themeColor v kořenovém layoutu je barva plochy stránky', () => {
    const layout = readFileSync(join(ROOT, 'src/app/layout.tsx'), 'utf-8');
    expect(layout).toContain(`themeColor: '${UI_TOKENS.background}'`);
  });

  it('mlha ve scéně má barvu plochy stránky', () => {
    // Plátno je průhledné a kreslí se na stránku, takže jiná barva mlhy by
    // vzdálený kus zapatlala světlejším oparem místo aby zmizel do pozadí.
    const lighting = readFileSync(join(ROOT, 'src/components/viewer/Lighting.tsx'), 'utf-8');
    expect(lighting).toContain(`color: '${UI_TOKENS.background}'`);
  });
});

describe('HUD bere barvy z tématu', () => {
  it('v hud.tsx nezůstala ani jedna barva napsaná v kódu', () => {
    const hud = readFileSync(join(ROOT, 'src/fallback/hud.tsx'), 'utf-8');
    expect(hud.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('stav hry se pozná i podle barvy, nejen podle slova', () => {
    // `data-phase` na banneru je to, na co se váže `--ws-positive` a
    // `--ws-negative`. Bez něj by výhra i prohra byly bílý text.
    expect(CSS).toContain("[data-phase='won']");
    expect(CSS).toContain("[data-phase='lost']");
  });
});

describe('žádný odstín ve fialovém pásmu', () => {
  // Globální pravidlo designu. Pásmo 250–320° je fialová až purpurová.
  const inBand = (hex: string): boolean => {
    const hue = hueOf(hex);
    return hue !== null && hue >= 250 && hue <= 320;
  };

  it('role scény', () => {
    expect(Object.entries(SCENE_ROLES).filter(([, hex]) => inBand(hex))).toEqual([]);
  });

  it('tokeny rozhraní, obě varianty', () => {
    const all = [...Object.entries(UI_TOKENS), ...Object.entries(UI_TOKENS_CVD)];
    expect(all.filter(([, hex]) => inBand(hex))).toEqual([]);
  });

  it('každý hex v theme.css', () => {
    const hexes = CSS.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexes.length).toBeGreaterThan(0);
    expect(hexes.filter((hex) => inBand(hex))).toEqual([]);
  });
});
