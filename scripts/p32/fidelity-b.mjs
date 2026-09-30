#!/usr/bin/env node
/**
 * Věrnost po přepojení na žánry (P32B T6): offline řetěz `scripts/play-fidelity.mjs`
 * nad korpusem 30 a `judge-10` na HEAD, spárovaný položku po položce se stavem
 * `evals/play/p30b/after.json` (P30B T7). Zdroje jsou tytéž: `draft` je slovní
 * draft nové hry (od P32B T2 žánr), `ai` jsou zmrazené AI specy `live.json`.
 * Model se nevolá.
 *
 *   node --experimental-strip-types scripts/p32/fidelity-b.mjs
 *
 * Zapíše `evals/play/p32/fidelity-b.json`; ztráty vysvětluje `fidelity-b.md`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { ROLES, measureSet } = await import('../p30b-losses.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETS = { corpus: 'corpus.json', judge10: 'judge-10.json' };
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const key = (set, source, id, item) => `${set}|${source}|${id}|${item}`;

const p30b = readJson(join(ROOT, 'evals', 'play', 'p30b', 'after.json'));
const was = new Map(p30b.sentences.flatMap((sentence) => sentence.items.map((item) => [key(sentence.set, sentence.source, sentence.id, item.item), { drawn: item.after, control: sentence.control }])));

const live = readJson(join(ROOT, 'evals', 'play', 'p30b', 'live.json'));
const rows = Object.entries(SETS).flatMap(([set, file]) =>
  measureSet(readJson(join(ROOT, 'evals', 'play', 'fidelity', file)).sentences, live.sentences.filter((entry) => entry.set === set)).map((row) => ({ ...row, set })),
);
if (rows.length !== was.size) throw new Error(`P30B has ${was.size} items, HEAD ${rows.length}`);

const totals = Object.fromEntries(
  Object.keys(SETS).map((set) => [set, Object.fromEntries(['draft', 'ai'].map((source) => [source, Object.fromEntries(ROLES.map((role) => [role, { of: 0, before: 0, after: 0 }]))]))]),
);
const sentences = new Map();
for (const row of rows) {
  const before = was.get(key(row.set, row.source, row.id, row.item));
  if (before === undefined) throw new Error(`item missing from P30B: ${key(row.set, row.source, row.id, row.item)}`);
  const at = `${row.set}|${row.source}|${row.id}`;
  const sentence = sentences.get(at) ?? { set: row.set, source: row.source, id: row.id, controlBefore: before.control, control: row.control, items: [] };
  sentence.items.push({ item: row.item, role: row.role, before: before.drawn, after: row.drawn, why: row.why });
  sentences.set(at, sentence);
  const tally = totals[row.set][row.source][row.role];
  tally.of += 1;
  tally.before += before.drawn ? 1 : 0;
  tally.after += row.drawn ? 1 : 0;
}

const result = {
  about: 'P32B T6: offline fidelity after the genre rewire. before = evals/play/p30b/after.json (P30B T7, after), after = HEAD. Word draft (a genre game since P32B T2) and the frozen AI specs of evals/play/p30b/live.json, corpus 30 + judge-10, no model. Losses explained in fidelity-b.md.',
  measuredAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  baseline: { file: 'evals/play/p30b/after.json', commit: p30b.commit },
  totals,
  sentences: [...sentences.values()],
};
writeFileSync(join(ROOT, 'evals', 'play', 'p32', 'fidelity-b.json'), `${JSON.stringify(result, null, 1)}\n`);
const sum = (role, side) => Object.values(totals).reduce((total, sources) => total + sources.draft[role][side] + sources.ai[role][side], 0);
console.log(Object.fromEntries(ROLES.map((role) => [role, `${sum(role, 'before')} -> ${sum(role, 'after')}`])));
for (const sentence of result.sentences) {
  for (const item of sentence.items) if (item.before !== item.after) console.log(item.before ? 'LOST' : 'GAIN', sentence.set, sentence.source, sentence.id, `${sentence.controlBefore} -> ${sentence.control}`, item.role, item.item, item.why);
}
