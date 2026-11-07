/**
 * Barva oparu malovaného pozadí (P75 T5): průměr pruhu obrazu těsně nad obzorem
 * (`PAINTED_SKIES` = řádek obzoru shora) po celé šířce. Ta patří do `horizon` místa
 * v `LOOKS`, ať mlha, siluety a dnešní obloha prvního snímku navazují na obraz.
 *
 *   node scripts/play/p75-haze.mjs            # všechna místa z PAINTED_SKIES
 *   node scripts/play/p75-haze.mjs volcano    # jedno
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';
import { Color, SRGBColorSpace } from 'three';

const ROOT = join(import.meta.dirname, '..', '..');
/** Výška pruhu nad obzorem (podíl výšky obrazu). */
const BAND = 0.04;
/** `FOG_SATURATION` z `look/rig/fog-light.ts`. */
const FOG_SATURATION = 0.18;

const source = readFileSync(join(ROOT, 'src/play/arcade/look/index.ts'), 'utf8');
const block = source.slice(source.indexOf('export const PAINTED_SKIES'), source.indexOf('};', source.indexOf('export const PAINTED_SKIES')));
const rows = Object.fromEntries([...block.matchAll(/^\s+(\w+): ([\d.]+),$/gm)].map((match) => [match[1], Number(match[2])]));
const wanted = process.argv.slice(2);

/** Průměr pruhu řádků `from`–`to` (podíl výšky shora) jako `Color` v sRGB. */
async function bandColor(file, from, to) {
  const image = sharp(file);
  const { width, height } = await image.metadata();
  const top = Math.max(0, Math.round(from * height));
  // `stats()` počítá ze vstupu, ne z výřezu: výřez napřed do bufferu.
  const band = await image.extract({ left: 0, top, width, height: Math.max(1, Math.round(to * height) - top) }).png().toBuffer();
  const { channels } = await sharp(band).stats();
  return new Color().setRGB(...channels.slice(0, 3).map((channel) => channel.mean / 255), SRGBColorSpace);
}

for (const [place, row] of Object.entries(rows)) {
  if (wanted.length > 0 && !wanted.includes(place)) continue;
  const file = join(ROOT, `public/play/env/diorama-${place}.webp`);
  const haze = await bandColor(file, row - BAND, row);
  // `airOf` přidá obzoru sytost `FOG_SATURATION`: obzor ji má o tolik nižší, ať mlha vyjde jako obraz.
  const hsl = haze.getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);
  const horizon = new Color().setHSL(hsl.h, Math.max(0, hsl.s - FOG_SATURATION), hsl.l, SRGBColorSpace);
  const ground = await bandColor(file, 0.85, 0.97);
  console.log(`${place.padEnd(11)} haze #${haze.getHexString(SRGBColorSpace)} horizon #${horizon.getHexString(SRGBColorSpace)} ground #${ground.getHexString(SRGBColorSpace)}`);
}
