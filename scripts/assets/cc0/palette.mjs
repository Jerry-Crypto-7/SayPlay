/**
 * Paleta projektu pro CC0 modely (P26A T4).
 *
 * Zdroj je `PALETTE` v `scripts/assets/blender/game_models.py` – tytéž barvy,
 * ze kterých jsou vlastní herní modely, takže balíky tří autorů dostanou
 * jednu barevnost. Barva vrcholu se nahradí nejbližší barvou palety v OKLab.
 * Fialová (odstín 250–320°, sytost nad 0,25) se v paletě ani ve výstupu
 * objevit nesmí – pravidlo projektu.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../blender/game_models.py', import.meta.url));

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
export const toSrgb = (linear) => linear.slice(0, 3).map((c) => Math.min(1, Math.max(0, fromLinear(c))));

/** Odstín ve stupních a sytost HSV nad sRGB 0–1. */
export function hueSat([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  return { hue: (hue + 360) % 360, sat: max === 0 ? 0 : d / max };
}

export function isPurple(srgb) {
  const { hue, sat } = hueSat(srgb);
  return hue >= 250 && hue <= 320 && sat > 0.25;
}

function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Barvy z bloku `PALETTE = { … }`; každá fialová by byla chyba zdroje, ne tichý filtr. */
export function loadPalette(source = readFileSync(SOURCE, 'utf8')) {
  const block = source.slice(source.indexOf('PALETTE = {'), source.indexOf('}', source.indexOf('PALETTE = {')));
  const palette = [...block.matchAll(/"([a-z-]+)": \("#([0-9a-f]{6})"/g)].map(([, name, hex]) => {
    const srgb = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    const linear = srgb.map(toLinear);
    return { name, hex: `#${hex}`, srgb, linear, lab: oklab(linear) };
  });
  const purple = palette.find((entry) => isPurple(entry.srgb));
  if (purple) throw new Error(`palette colour ${purple.name} ${purple.hex} is purple`);
  if (palette.length === 0) throw new Error('no PALETTE block in game_models.py');
  return palette;
}

export function nearest(linear, palette) {
  const lab = oklab(linear);
  let best = palette[0];
  let bestDistance = Infinity;
  for (const entry of palette) {
    const distance = (lab[0] - entry.lab[0]) ** 2 + (lab[1] - entry.lab[1]) ** 2 + (lab[2] - entry.lab[2]) ** 2;
    if (distance < bestDistance) { best = entry; bestDistance = distance; }
  }
  return best;
}

/**
 * Přemapuje COLOR_0 primitiv na paletu; průhlednost (4. složka) zůstává.
 * Primitiva v `skip` (s texturou) nechá být – nejbližší barva po vrcholech
 * láme přechod textury na střepy různých barev palety.
 */
export function recolorDoc(doc, palette, skip = new Set()) {
  const seen = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const colour = prim.getAttribute('COLOR_0');
      if (!colour || seen.has(colour) || skip.has(prim)) continue;
      seen.add(colour);
      const element = [];
      for (let i = 0; i < colour.getCount(); i++) {
        colour.getElement(i, element);
        const { linear } = nearest(element.slice(0, 3), palette);
        colour.setElement(i, element.length === 4 ? [...linear, element[3]] : [...linear]);
      }
    }
  }
}
