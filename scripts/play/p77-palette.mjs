#!/usr/bin/env node
/**
 * P77 T2: paleta místa z konceptu. Pro každý koncept `evals/play/p75/target/<věta>.png` k-means (k = 8, Oklab,
 * pevné semínko) nad pixely bez nejtmavších a nejsvětlejších (stín a odlesk tón neřeknou) → tóny seřazené podle
 * podílu plochy. Výstup `evals/play/p77/palette.json` a `palette.md` (vzorník), z nich se ručně píše `palette`
 * v `LOOKS` (`src/play/arcade/look/index.ts`).
 *
 *   node scripts/play/p77-palette.mjs [--k 8]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evals', 'play', 'p77');
const require = createRequire(import.meta.url);

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function hexOf([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((c) => Math.round(Math.min(Math.max(gamma(Math.max(c, 0)), 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** k-means s pevnou inicializací (body rovnoměrně po seřazení podle světlosti) – stejný výsledek při každém běhu. */
function kmeans(points, k) {
  const sorted = [...points].sort((p, q) => p[0] - q[0]);
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)]);
  let counts = new Array(k).fill(0);
  for (let round = 0; round < 25; round += 1) {
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    counts = new Array(k).fill(0);
    for (const p of points) {
      let best = 0;
      let gap = Infinity;
      centers.forEach((c, i) => {
        const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
        if (d < gap) [gap, best] = [d, i];
      });
      counts[best] += 1;
      for (let n = 0; n < 3; n += 1) sums[best][n] += p[n];
    }
    centers = centers.map((c, i) => (counts[i] === 0 ? c : sums[i].map((v) => v / counts[i])));
  }
  return centers.map((c, i) => ({ lab: c, share: counts[i] / points.length })).sort((p, q) => q.share - p.share);
}

async function main() {
  const options = args();
  const k = Number(options.k ?? 8);
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const result = {};
  try {
    const page = await browser.newPage();
    for (const sentence of SENTENCES) {
      const png = readFileSync(join(ROOT, 'evals', 'play', 'p75', 'target', `${sentence.id}.png`)).toString('base64');
      // Každý 4. pixel v obou osách: 1152×640 → ~46 tisíc bodů.
      const rgba = await page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width / 4;
        canvas.height = image.height / 4;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
      }, png);
      const points = [];
      for (let at = 0; at < rgba.length; at += 4) {
        const lab = oklab(linear(rgba[at] / 255), linear(rgba[at + 1] / 255), linear(rgba[at + 2] / 255));
        if (lab[0] > 0.25 && lab[0] < 0.95) points.push(lab);
      }
      result[sentence.id] = { text: sentence.text, tones: kmeans(points, k).map(({ lab, share }) => ({ hex: hexOf(lab), share: Math.round(share * 1000) / 1000, chroma: Math.round(Math.hypot(lab[1], lab[2]) * 1000) / 1000 })) };
      console.log(`${sentence.id}: ${result[sentence.id].tones.map((tone) => tone.hex).join(' ')}`);
    }
  } finally {
    await browser.close();
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'palette.json'), `${JSON.stringify(result, null, 1)}\n`);
  const swatch = (hex) => `<span style="background:${hex};display:inline-block;width:2em">&nbsp;</span> \`${hex}\``;
  const lines = ['# P77 T2 – tóny konceptů (k-means v Oklab)', '', 'Skript `scripts/play/p77-palette.mjs`: koncept `evals/play/p75/target/<věta>.png`, každý 4. pixel, bez světlosti pod 0,25 a nad 0,95, k = 8; seřazeno podle podílu plochy.', '', '| # | věta | tóny |', '|---|---|---|'];
  for (const [id, { text, tones }] of Object.entries(result)) lines.push(`| ${id} | ${text} | ${tones.map((tone) => `${swatch(tone.hex)} ${Math.round(tone.share * 100)} %`).join('<br>')} |`);
  writeFileSync(join(OUT, 'palette.md'), `${lines.join('\n')}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
