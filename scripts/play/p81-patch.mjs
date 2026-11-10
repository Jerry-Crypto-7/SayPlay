#!/usr/bin/env node
/**
 * P81 R3: průměrná barva výřezů snímku (sRGB 0–255) a jejich odstín – rozbor, co hýbe odstínem středu `p81-diff.mjs`.
 *
 *   node scripts/play/p81-patch.mjs <snímek.jpg> [x0,y0,x1,y1 ...]   (podíly šířky a výšky)
 */
import sharp from 'sharp';

const [file, ...boxes] = process.argv.slice(2);
const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
for (const box of boxes.length > 0 ? boxes : ['0.35,0.4,0.65,0.8']) {
  const [x0, y0, x1, y1] = box.split(',').map(Number);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(info.height * y0); y < Math.floor(info.height * y1); y += 1) {
    for (let x = Math.floor(info.width * x0); x < Math.floor(info.width * x1); x += 1) {
      const i = (y * info.width + x) * 3;
      for (let c = 0; c < 3; c += 1) sum[c] += data[i + c];
      n += 1;
    }
  }
  const [r, g, b] = sum.map((value) => value / n);
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  const hue = chroma === 0 ? 0 : ((((max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4) * 60) + 360) % 360);
  console.log(`${box}  rgb ${[r, g, b].map((value) => value.toFixed(0)).join(',')}  hue ${hue.toFixed(0)}  chroma ${chroma.toFixed(0)}`);
}
