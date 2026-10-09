#!/usr/bin/env node
/**
 * Výběr chybějících podstatných jmen pro kolo generování P45D (T16).
 *
 *   node scripts/p45d/pick-nouns.mjs      zapíše evals/play/p45d/gen-nouns.json
 *
 * Vstup je čerstvý `evals/play/p45d/missing.json` (`scripts/p37d/missing-nouns.mjs
 * --out …` nad dnešním katalogem), takže nic, co knihovna už kreslí, se nevybere.
 * Pořadí: hrdinové panelu P43 bez modelu (`evals/play/p45d/baseline.json`) → podle
 * počtu vět → jména, která soudce P43 zaměnil za něco jiného (`evals/play/p43/gen3d.md`).
 * Jevy, kulisy a šum (`scripts/p45d/not-models.txt`) vypadnou. Každé jméno nese třídu
 * těla (`bodyOfNoun`, jinak `prop`) pro šablonu zadání a příznak `flat` pro plochá
 * a drobná jména, která generátor kreslí jako placku.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `motion-class.mjs` čte `roles.ts`; holý `node` ho načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { bodyOfNoun } = await import('./motion-class.mjs');

export const OUT = 'evals/play/p45d/gen-nouns.json';
export const MAX_NOUNS = 60;

/** Plochá a drobná jména (P43: receipt → recycling bin, playing card → fuel can); šablona `flat` je vyrobí jako tlustou hračku. */
export const FLAT = new Set([
  'receipt', 'playing card', 'passport', 'ticket', 'mahjong tile', 'newspaper', 'magazine', 'portrait', 'canvas', 'notebook',
  'tablet', 'keyboard', 'frisbee', 'snowboard', 'towel', 'blanket', 'cape', 'net', 'earring', 'pebble', 'golf ball', 'seashell', 'ammo', 'tape',
]);

/** Seznam po řádcích; `#` uvozuje komentář. */
export function parseList(text) {
  return new Set(text.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean));
}

/** Jména z odstavce „Soudce poznal něco jiného“ v `evals/play/p43/gen3d.md` (`jméno: co viděl · …`). */
export function confusedOf(markdown) {
  const line = markdown.match(/\*\*Soudce poznal něco jiného[^\n]*\n([^\n]+)/)?.[1];
  if (line === undefined) throw new Error('gen3d.md: no "Soudce poznal něco jiného" paragraph');
  return line.split(' · ').map((pair) => pair.split(':')[0].trim().toLowerCase());
}

/** Hrdinové vět panelu, u kterých výchozí měření nenašlo model. */
export function panelHeroesWithoutModel(baseline, panel) {
  const without = new Set(baseline.rows.filter((row) => row.heroModel === false).map((row) => row.id));
  return panel.sentences
    .filter((sentence) => without.has(sentence.id))
    .map((sentence) => sentence.checklist?.find((entry) => entry.slot === 'hero')?.item.toLowerCase())
    .filter((noun) => noun !== undefined);
}

/** Nejvýš `max` jmen z `missing` v pořadí hrdina → poptávka → záměna P43. */
export function pickNouns({ missing, heroes, confused, notModels, max = MAX_NOUNS }) {
  const byNoun = new Map(missing.map((entry) => [entry.noun, entry]));
  const picked = new Map();
  const take = (noun, why) => {
    const entry = byNoun.get(noun);
    if (entry === undefined || notModels.has(noun) || picked.has(noun) || picked.size >= max) return;
    picked.set(noun, { noun, why, class: bodyOfNoun(noun) ?? 'prop', flat: FLAT.has(noun), sentences: entry.sentences });
  };
  for (const noun of heroes) take(noun, 'hero');
  for (const entry of missing) if (entry.sentences > 0) take(entry.noun, 'demand');
  for (const noun of confused) take(noun, 'confused');
  return [...picked.values()];
}

const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));

/** Výběr nad soubory repa. */
export function pickFromRepo() {
  return pickNouns({
    missing: readJson('evals/play/p45d/missing.json').missing,
    heroes: panelHeroesWithoutModel(readJson('evals/play/p45d/baseline.json'), readJson('evals/play/p43/panel.json')),
    confused: confusedOf(readFileSync(path.join(ROOT, 'evals/play/p43/gen3d.md'), 'utf8')),
    notModels: parseList(readFileSync(path.join(ROOT, 'scripts/p45d/not-models.txt'), 'utf8')),
  });
}

if (isMain) {
  const nouns = pickFromRepo();
  const count = (key, value) => nouns.filter((entry) => entry[key] === value).length;
  const report = {
    about:
      'P45D T16: missing nouns for the generation round, at most 60. Order: P43 panel heroes without a model (evals/play/p45d/baseline.json), then sentence count (evals/play/p45d/missing.json), then nouns the P43 judge mistook for something else (evals/play/p43/gen3d.md). Phenomena, scenery and noise from scripts/p45d/not-models.txt are dropped. class = body class for the prompt template (prop when the words name none); flat = flat or tiny noun. Written by scripts/p45d/pick-nouns.mjs.',
    counts: { total: nouns.length, hero: count('why', 'hero'), demand: count('why', 'demand'), confused: count('why', 'confused'), flat: count('flat', true) },
    nouns,
  };
  writeFileSync(path.join(ROOT, OUT), `${JSON.stringify(report, null, 1).replace(/\{\n\s+("noun"[^}]+)\n\s+\}/g, (_, body) => `{${body.replace(/\n\s+/g, '')}}`)}\n`);
  console.log(JSON.stringify(report.counts));
}
