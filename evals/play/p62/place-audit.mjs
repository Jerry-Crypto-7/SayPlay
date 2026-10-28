#!/usr/bin/env node
/**
 * P62 T9: audit, jestli rychlá hra kreslí místo, které věta jmenuje. Jen otevřené věty: 220 vět auditu T1
 * (`p30/dev.json` s dev větami P62, `p58b/holdout.json`, `p56c/*.json`) a otevřené holdouty `p61/holdout.json` a
 * `p62/holdout.json`. Zapečetěná sada B (`p62/holdout-b.json`) se nečte nikdy.
 *
 *   node evals/play/p62/place-audit.mjs          zapíše evals/play/p62/place-audit.json
 *   node evals/play/p62/place-audit.mjs --list   vypíše id a text vět bez štítku (podklad pro ruční štítky)
 *
 * Štítky jsou ruční data (`place-labels.json`): `place` = místo, jak ho věta jmenuje (`null` = věta místo nejmenuje,
 * do počtu nejde), `ok` = sady, ve kterých by divák to místo poznal. Místo bez vlastní sady má v `ok` nejbližší
 * venkovní nebo neutrální sadu; interiér jen tehdy, když věta interiér jmenuje.
 *
 * Kreslená sada = `lookOf(spec.theme)` rychlé hry z dveří `/api/play/games` (`quickGame` z `audit.mjs`, recept P61:
 * kolo 1 řetězu, jinak návrh ze slov). Špatné místo dostane jednu třídu, první, která sedí:
 * 1. `compound` – místo má víc slov a kreslená sada je sada jednoho z nich („night market“ → market → supermarket);
 * 2. `overridden` – místo přebilo jiné slovo věty, jehož sadu scéna kreslí (tvor, předmět: „paper boat … gutter“ →
 *    oceán), nebo slova místa vedou do `ok` a scéna přesto kreslí jinou sadu (výchozí místo žánru, volba návrhu);
 * 3. `foreign-interior` – kreslí se interiér a věta žádný interiér, který by sada měla, nejmenuje;
 * 4. `unknown-place` – místo žádná sada nezná (`lookFor(place)` je `null`) a scéna kreslí zálohu: louku nebo
 *    výchozí místo žánru;
 * 5. `other` – cokoli jiného.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Aplikace je TypeScript; holý `node` ji načte až s odstraňováním typů (jako `audit.mjs`).
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const { auditSets, INTERIOR_LOOKS, quickGame } = await import('./audit.mjs');
const { LOOK_IDS, lookFor, lookOf } = await import('../../../src/play/arcade/look/index.ts');
const { loadRapier } = await import('../../../src/play/arcade/physics/world.ts');
const { normalizeSentence } = await import('../../../scripts/play-fidelity.mjs');

const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));

/** Otevřené sady (cesty od `evals/play`), v pořadí, ve kterém věta dostane id (první sada, kde stojí). */
export const placeAuditSets = () => [...auditSets(), 'p61/holdout.json', 'p62/holdout.json'];

/** Věty otevřených sad bez opakování: id `sada:id` z první sady, kde věta stojí, a seznam všech výskytů. */
export function openSentences() {
  const sentences = new Map();
  for (const set of placeAuditSets()) {
    const json = readJson(`evals/play/${set}`);
    for (const row of Array.isArray(json) ? json : json.sentences) {
      const key = normalizeSentence(row.text);
      const seen = sentences.get(key) ?? { id: `${set.replace(/\.json$/, '')}:${row.id}`, text: row.text, sets: [] };
      seen.sets.push(`${set}#${row.id}`);
      sentences.set(key, seen);
    }
  }
  return [...sentences.values()];
}

const words = (text) => text.toLowerCase().match(/[\p{L}']+/gu) ?? [];

/** Třída špatného místa (pořadí v hlavičce souboru); `null` = místo sedí nebo věta žádné nejmenuje. */
export function placeClass(label, drawn, text = '') {
  if (label.place === null || label.ok.includes(drawn)) return null;
  const parts = words(label.place);
  if (parts.length > 1 && parts.some((word) => lookFor(word) === drawn)) return 'compound';
  const named = lookFor(label.place);
  const others = words(text).filter((word) => !parts.includes(word));
  if ((named !== null && label.ok.includes(named)) || others.some((word) => lookFor(word) === drawn)) return 'overridden';
  if (INTERIOR_LOOKS.has(drawn) && !label.ok.some((look) => INTERIOR_LOOKS.has(look))) return 'foreign-interior';
  if (named === null) return 'unknown-place';
  return 'other';
}

/** Řádek auditu: štítek, kreslená sada a třída. */
export function placeRow(sentence, label, drawn) {
  const cls = placeClass(label, drawn, sentence.text);
  return { id: sentence.id, text: sentence.text, place: label.place, ok: label.ok, drawn, verdict: label.place === null ? 'no-place' : cls === null ? 'right' : 'wrong', ...(cls === null ? {} : { class: cls }) };
}

/** Počty: věty se jmenovaným místem, správně, špatně a po třídách. */
export function summarizePlaces(rows) {
  const named = rows.filter((row) => row.verdict !== 'no-place');
  const wrong = named.filter((row) => row.verdict === 'wrong');
  const classes = { compound: 0, overridden: 0, 'foreign-interior': 0, 'unknown-place': 0, other: 0 };
  for (const row of wrong) classes[row.class] += 1;
  return { sentences: rows.length, namedPlace: named.length, right: named.length - wrong.length, wrong: wrong.length, classes };
}

/** Ruční štítky podle id věty. */
export function labelsById() {
  const { labels } = readJson('evals/play/p62/place-labels.json');
  return new Map(labels.map((label) => [label.id, label]));
}

async function main() {
  const sentences = openSentences();
  const labels = labelsById();
  if (process.argv.includes('--list')) {
    for (const sentence of sentences.filter((s) => !labels.has(s.id))) console.log(`${sentence.id}\t${sentence.text}`);
    return;
  }
  const missing = sentences.filter((s) => !labels.has(s.id)).map((s) => s.id);
  const stale = [...labels.keys()].filter((id) => !sentences.some((s) => s.id === id));
  if (missing.length > 0 || stale.length > 0) throw new Error(`place-labels.json: no label for ${missing.join(', ') || '–'}; label without a sentence ${stale.join(', ') || '–'}`);
  const unknown = [...labels.values()].flatMap((label) => label.ok).filter((look) => !LOOK_IDS.includes(look));
  if (unknown.length > 0) throw new Error(`place-labels.json names looks that do not exist: ${[...new Set(unknown)].join(', ')}`);
  await loadRapier();
  const rows = sentences.map((sentence) => {
    const quick = quickGame(sentence.text);
    return { ...placeRow(sentence, labels.get(sentence.id), lookOf(quick.spec.theme)), themeLook: quick.spec.theme?.look ?? null, chain: quick.chain, genre: quick.spec.genre === undefined ? null : `${quick.spec.genre.id}.${quick.spec.genre.mode}` };
  });
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const summary = summarizePlaces(rows);
  const audit = {
    schema: 'p62-place-audit.v1',
    about: 'P62 T9: does the quick game draw the place the sentence names? Open sentences only (the 220 of the T1 audit, p61/holdout.json, p62/holdout.json); sealed set B is never read. place/ok are hand labels from place-labels.json (ok = looks in which a viewer would recognise the place; a place without its own look gets the nearest outdoor or neutral one, an interior only when the sentence names one). drawn = lookOf(spec.theme) of the quick game at the /api/play/games door (chain round 1 or the word draft). class of a wrong place, first that fits: compound = a multi-word place drawn as the look of one of its words; overridden = another word of the sentence (a creature, an item) gave the drawn look, or the place words lead to an ok look and the scene draws another; foreign-interior = an interior drawn where the sentence names no interior a look has; unknown-place = no look knows the place and the scene draws a fallback (meadow or the genre default); other. Written by evals/play/p62/place-audit.mjs.',
    srcCommit: commit,
    sets: placeAuditSets(),
    summary,
  };
  const oneLine = (list) => `[\n  ${list.map((item) => JSON.stringify(item)).join(',\n  ')}\n ]`;
  writeFileSync(path.join(HERE, 'place-audit.json'), `${JSON.stringify(audit, null, 1).replace(/\n}$/, '')},\n "rows": ${oneLine(rows)}\n}\n`);
  console.log(JSON.stringify(summary));
}

if (isMain) await main();
