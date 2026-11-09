#!/usr/bin/env node
/**
 * P81 rozdílová metrika snímků: kolik obrazu se mezi dvěma složkami fotek (`p77-shots.mjs`) opravdu změnilo.
 * Pro každý snímek, který je v obou složkách, spočítá podíl pixelů, kde se některý kanál pohnul o víc než
 * `--threshold` (výchozí 24 z 255), a průměrný odstín středu snímku (hrdina a podlaha pod ním) – kruhový
 * průměr vážený sytostí, aby šedé plochy odstín nepřehlasovaly.
 *
 *   node scripts/play/p81-diff.mjs --a evals/play/p81/base --b evals/play/p77/after [--md evals/play/p81/diff-p77.md]
 *
 * Shrnutí: medián a minimum změny `desktop-1play` přes hry a největší posun odstínu středu (`desktop-1play`).
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { args } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOT = /^(s\d+)-(desktop|phone)-(\w+)\.jpg$/;
/** Střed snímku, kde stojí hrdina a podlaha pod ním (podíl šířky a výšky). */
const CENTER = { x0: 0.35, x1: 0.65, y0: 0.4, y1: 0.8 };

async function pixels(file, size) {
  let image = sharp(file).removeAlpha();
  if (size !== undefined) image = image.resize(size.width, size.height, { fit: 'fill' });
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Kruhový průměr odstínu (stupně) vážený chromou; `null`, když je oblast bez barvy. */
function centerHue({ data, width, height }) {
  let cos = 0;
  let sin = 0;
  let weight = 0;
  for (let y = Math.floor(height * CENTER.y0); y < Math.floor(height * CENTER.y1); y += 1) {
    for (let x = Math.floor(width * CENTER.x0); x < Math.floor(width * CENTER.x1); x += 1) {
      const i = (y * width + x) * 3;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const chroma = max - Math.min(r, g, b);
      if (chroma === 0) continue;
      let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
      hue = (hue * Math.PI) / 3;
      cos += Math.cos(hue) * chroma;
      sin += Math.sin(hue) * chroma;
      weight += chroma;
    }
  }
  if (weight === 0) return null;
  return ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
}

const hueShift = (a, b) => (a === null || b === null ? null : Math.abs(((b - a + 540) % 360) - 180));

/** Podíl fialových pixelů celého snímku (P81 R3): odstín 250–320°, chroma aspoň 24/255 – šeď a šum JPEG nepočítá. */
function purpleShare({ data, width, height }) {
  let purple = 0;
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma < 24) continue;
    const hue = (((max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4) * 60) + 360) % 360;
    if (hue >= 250 && hue <= 320) purple += 1;
  }
  return purple / (width * height);
}

async function compare(fileA, fileB, threshold) {
  const a = await pixels(fileA);
  const b = await pixels(fileB, { width: a.width, height: a.height });
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 3) {
    const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (delta > threshold) changed += 1;
  }
  const hueA = centerHue(a);
  const hueB = centerHue(b);
  return { changed: changed / (a.width * a.height), hueA, hueB, hueShift: hueShift(hueA, hueB), purpleA: purpleShare(a), purpleB: purpleShare(b) };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const pct = (value) => (value === null ? '–' : `${(value * 100).toFixed(1)} %`);
const deg = (value) => (value === null ? '–' : `${value.toFixed(0)}°`);

async function main() {
  const options = args();
  if (typeof options.a !== 'string' || typeof options.b !== 'string') throw new Error('needs --a <dir> --b <dir>');
  const dirA = resolve(ROOT, options.a);
  const dirB = resolve(ROOT, options.b);
  const threshold = typeof options.threshold === 'string' ? Number(options.threshold) : 24;
  const rows = [];
  for (const file of readdirSync(dirA).sort()) {
    const match = SHOT.exec(file);
    if (match === null || !existsSync(resolve(dirB, file))) continue;
    rows.push({ game: match[1], vp: match[2], moment: match[3], file, ...(await compare(resolve(dirA, file), resolve(dirB, file), threshold)) });
  }
  if (rows.length === 0) throw new Error('no shot is in both folders');

  const games = [...new Set(rows.map((row) => row.game))].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
  const key = (vp, moment) => (game) => rows.find((row) => row.game === game && row.vp === vp && row.moment === moment);
  const play = games.map(key('desktop', '1play')).filter((row) => row !== undefined);
  const summary = {
    shots: rows.length,
    medianDesktopPlay: median(play.map((row) => row.changed)),
    minDesktopPlay: play.length === 0 ? null : Math.min(...play.map((row) => row.changed)),
    medianAll: median(rows.map((row) => row.changed)),
    maxHueShift: play.reduce((max, row) => (row.hueShift === null ? max : Math.max(max ?? 0, row.hueShift)), null),
    maxPurpleA: Math.max(...rows.map((row) => row.purpleA)),
    maxPurpleB: Math.max(...rows.map((row) => row.purpleB)),
  };

  const lines = [
    `# P81 rozdíl snímků: \`${options.a}\` → \`${options.b}\``,
    '',
    `Práh: kanál se pohnul o víc než ${threshold}/255. Odstín středu = kruhový průměr vážený sytostí ve výřezu x ${CENTER.x0}–${CENTER.x1}, y ${CENTER.y0}–${CENTER.y1}.`,
    '',
    `- Snímků v obou složkách: ${summary.shots}`,
    `- **Medián desktop-1play: ${pct(summary.medianDesktopPlay)}**, nejmenší ${pct(summary.minDesktopPlay)}`,
    `- Medián všech snímků: ${pct(summary.medianAll)}`,
    `- Největší posun odstínu středu (desktop-1play): ${deg(summary.maxHueShift)}`,
    `- Fialová (odstín 250–320°, chroma ≥ 24): nejvíc ${(summary.maxPurpleA * 100).toFixed(2)} % snímku před, ${(summary.maxPurpleB * 100).toFixed(2)} % po`,
    '',
    '| Hra | desktop start | desktop 3 s | desktop 8 s | telefon start | telefon 3 s | telefon 8 s | odstín středu 3 s (před → po, posun) | fialová nejvíc (před → po) |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const share = (value) => `${(value * 100).toFixed(2)} %`;
  for (const game of games) {
    const cell = (vp, moment) => pct(key(vp, moment)(game)?.changed ?? null);
    const hue = key('desktop', '1play')(game);
    const own = rows.filter((row) => row.game === game);
    lines.push(
      `| ${game} | ${cell('desktop', '0start')} | ${cell('desktop', '1play')} | ${cell('desktop', '2play')} | ${cell('phone', '0start')} | ${cell('phone', '1play')} | ${cell('phone', '2play')} | ${hue === undefined ? '–' : `${deg(hue.hueA)} → ${deg(hue.hueB)}, ${deg(hue.hueShift)}`} | ${share(Math.max(...own.map((row) => row.purpleA)))} → ${share(Math.max(...own.map((row) => row.purpleB)))} |`,
    );
  }
  const markdown = `${lines.join('\n')}\n`;
  if (typeof options.md === 'string') writeFileSync(resolve(ROOT, options.md), markdown);
  console.log(markdown);
  console.log(`P81_DIFF ${JSON.stringify(summary)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
