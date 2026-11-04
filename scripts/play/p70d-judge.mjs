/**
 * P70D T5: slepý soud před/po. Pro každou skupinu 4 scén jeden list – v řádku dva snímky 3. vteřiny téže scény
 * (A vlevo, B vpravo; strana „po“ z `afterSideOf`) – a jedna otázka `codex exec -i` přes `ask()` z P37D
 * (`sheet.png` v prázdném dočasném adresáři, bez web searche, odpověď podle schématu). 8 scén = 2 volání.
 *
 *   node --experimental-strip-types --no-warnings scripts/play/p70d-judge.mjs [--group 4]
 *
 * Píše `evals/play/p70d/after/judge.json` (strany, odpovědi, verdikty); přepočet a `result.md` dělá `p70d-result.mjs`.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { SALT, afterSideOf, verdictOf } from './p70d-result.mjs';
import { SCENES } from './p70d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sharp = createRequire(import.meta.url)('sharp');
const SHOT = '03s';
/** Snímek na listu (px): 430 × 900 zmenšené na šířku `W`. */
const W = 260;
const H = Math.round((W * 900) / 430);
const GAP = 16;
const HEAD = 40;
const SIDE = 44;

const QUESTION =
  'sheet.png has numbered rows; each row shows two phone screenshots of the same game scene, A on the left and B on the right. For each row pick the screenshot that looks more appealing and reads more clearly for a player (hero, goal, obstacles and pickups easy to see). Reply per the JSON schema: one entry per row with the row number, pick A or B, and a short why. Do not search the web and do not run any skill.';

const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: { type: 'object', properties: { row: { type: 'integer' }, pick: { type: 'string', enum: ['A', 'B'] }, why: { type: 'string' } }, required: ['row', 'pick', 'why'], additionalProperties: false },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

const valid = (value) => Array.isArray(value?.rows) && value.rows.every((row) => Number.isInteger(row.row) && (row.pick === 'A' || row.pick === 'B'));

const label = (text, width, height) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="50%" y="70%" text-anchor="middle" font-family="Arial" font-size="28" font-weight="700" fill="#111">${text}</text></svg>`);

/** List skupiny: řádek k = scéna k, snímek „po“ na straně `afterSideOf`. */
async function sheetOf(ids, file) {
  const width = SIDE + 2 * W + 3 * GAP;
  const height = HEAD + ids.length * (H + GAP);
  const layers = [
    { input: label('A', W, HEAD), left: SIDE + GAP, top: 0 },
    { input: label('B', W, HEAD), left: SIDE + 2 * GAP + W, top: 0 },
  ];
  for (const [k, id] of ids.entries()) {
    const top = HEAD + k * (H + GAP);
    const after = afterSideOf(id);
    const shot = async (dir) => sharp(join(ROOT, 'evals/play/p70d', dir, `${id}-${SHOT}.png`)).resize(W, H).png().toBuffer();
    const [left, right] = after === 'A' ? [await shot('after'), await shot('baseline')] : [await shot('baseline'), await shot('after')];
    layers.push({ input: label(String(k + 1), SIDE, H), left: 0, top }, { input: left, left: SIDE + GAP, top }, { input: right, left: SIDE + 2 * GAP + W, top });
  }
  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(layers).png().toFile(file);
}

const args = process.argv.slice(2);
const group = Number(args[args.indexOf('--group') + 1] || 4) || 4;
const { ask } = await import('../p37d/judge-sheet.mjs');
const work = mkdtempSync(join(tmpdir(), 'p70d-'));
const schemaFile = join(work, 'schema.json');
writeFileSync(schemaFile, JSON.stringify(SCHEMA));
const ids = SCENES.map((scene) => scene.id);
const groups = [];
const verdicts = {};
for (let start = 0; start < ids.length; start += group) {
  const chunk = ids.slice(start, start + group);
  const sheet = join(work, `g${start}.png`);
  const answerFile = join(work, `g${start}.json`);
  await sheetOf(chunk, sheet);
  const run = await ask(sheet, schemaFile, answerFile, QUESTION, 'codex', valid);
  const answer = existsSync(answerFile) ? JSON.parse(readFileSync(answerFile, 'utf8')) : null;
  for (const [k, id] of chunk.entries()) verdicts[id] = verdictOf(answer?.rows?.find((row) => row.row === k + 1)?.pick, afterSideOf(id));
  groups.push({ scenes: chunk, afterSides: chunk.map((id) => afterSideOf(id)), answer, code: run.code, seconds: run.seconds, stderr: run.code === 0 ? undefined : run.stderr });
  console.log(`${chunk.join(',')}: code ${String(run.code)} ${String(run.seconds)} s → ${chunk.map((id) => verdicts[id]).join(',')}`);
}
writeFileSync(join(ROOT, 'evals/play/p70d/after/judge.json'), `${JSON.stringify({ salt: SALT, shot: SHOT, judge: 'codex exec -i (P37D ask)', groups, verdicts }, null, 2)}\n`);
console.log(`work ${work}`);
