#!/usr/bin/env node
/** Kontaktní arch dávky gen3d pro QA okem: náhled každého slova se jménem, verdiktem a časem.
 * node scripts/gen3d/contact-sheet.mjs evals/gen3d/batch.json evals/gen3d/batch-sheet.png */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';

const [recordFile, out] = process.argv.slice(2);
if (!recordFile || !out) throw new Error('Usage: contact-sheet.mjs batch.json sheet.png');
const { records } = JSON.parse(await readFile(recordFile, 'utf8'));

const TILE_W = 480, TILE_H = 160, LABEL_H = 26, COLUMNS = 3;
const escape = text => text.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);

const tiles = await Promise.all(records.map(async (record, i) => {
  const passed = record.verdict === 'passed';
  const picture = record.preview && existsSync(record.preview)
    ? await sharp(record.preview).resize(TILE_W, TILE_H, { fit: 'contain', background: '#bfbfbf' }).png().toBuffer()
    : await sharp({ create: { width: TILE_W, height: TILE_H, channels: 3, background: '#d9d9d9' } }).png().toBuffer();
  const note = passed ? `${record.seconds} s` : (record.reason ?? 'failed').slice(0, 60);
  const label = Buffer.from(`<svg width="${TILE_W}" height="${LABEL_H}">
    <rect width="100%" height="100%" fill="${passed ? '#1f3b2d' : '#5a1f1f'}"/>
    <text x="8" y="18" font-family="Arial" font-size="15" fill="#ffffff">${escape(`${record.noun} – ${passed ? 'passed' : 'FAILED'} – ${note}`)}</text>
  </svg>`);
  return [
    { input: picture, left: (i % COLUMNS) * TILE_W, top: Math.floor(i / COLUMNS) * (TILE_H + LABEL_H) },
    { input: label, left: (i % COLUMNS) * TILE_W, top: Math.floor(i / COLUMNS) * (TILE_H + LABEL_H) + TILE_H },
  ];
}));

const rows = Math.max(1, Math.ceil(records.length / COLUMNS));
await sharp({ create: { width: TILE_W * COLUMNS, height: rows * (TILE_H + LABEL_H), channels: 3, background: '#ffffff' } })
  .composite(tiles.flat()).png().toFile(out);
console.log(`${records.length} models -> ${out}`);
