/**
 * Proč soudce slovo věty neviděl (P58A T2). Nad `evals/play/p58a/baseline.json` (odpovědi soudce) a průchodem
 * rozměrů (`scripts/p58a/play-sets.mjs … --spec`: spec, jaký kreslil server, a `__playFrame` v okamžiku snímku)
 * zařadí každé neviděné slovo do jedné třídy, v tomhle pořadí:
 *
 * - `no-role` – slovo nenese žádná role specu (hrdina jen hráč, protivník či věc jen ostatní role);
 * - `no-model` – roli má, ale model je výchozí náhrada (`level: 'fallback'`);
 * - `off-screen` – tělo role není v záběru (za kamerou nebo celé mimo plátno, sonda ho nenašla);
 * - `too-small` – výška těla na plátně je pod prahem, nad kterým ho soudce na dev poznává;
 * - `look` – správná role, model a velikost, soudce ho přesto nepoznal.
 *
 * Práh je řez výškou (podíl výšky plátna), který nejlépe dělí viděná a neviděná slova s rolí, modelem a v záběru –
 * zvlášť hrdina (X pro T3) a protivník či věc (Y). Vedle toho `missing-nouns.json`: podstatná jména z popisků
 * dev sad a z nahraných čtení, která katalog nemá přesně (`level` ≠ `identity`), podle počtu vět v poptávce
 * a dev sadách.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/p58a/why-unseen.mjs --baseline evals/play/p58a/baseline.json \
 *     --frames <adresář>=<sada.json> [--frames …] --out evals/play/p58a/why.json --missing evals/play/p58a/missing-nouns.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { heroChoice } from '../../src/play/arcade/models.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

/** Tvary slova pro shodu s popiskem role: samo slovo a jednotné číslo, jak je píše korpus. */
function formsOf(word) {
  const out = [word];
  if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves')) out.push(`${word.slice(0, -3)}f`);
  if (word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.endsWith('s')) out.push(word.slice(0, -1));
  if (word.endsWith('men')) out.push(`${word.slice(0, -3)}man`);
  return out;
}

const wordsOf = (text) => String(text).toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
const headOf = (text) => wordsOf(text).at(-1) ?? '';

/** Popisek nese slovo, když se shodují celé fráze, nebo hlavy (poslední slovo) v kterémkoli tvaru. */
function carries(label, noun) {
  const phrase = (text) => wordsOf(text).join(' ');
  if (phrase(label) === phrase(noun)) return true;
  const own = new Set(formsOf(headOf(label)));
  return formsOf(headOf(noun)).some((form) => own.has(form));
}

/** Role, která slovo nese: hrdinu jen hráč, protivníka či věc jen ostatní role; žádná = `null`. */
export function carrierOf(noun, isHero, roles) {
  return roles.find((role) => (role.kind === 'player') === isHero && carries(role.label, noun)) ?? null;
}

/** Model role, jak ho vybírá scéna: hráč s hranicemi žánru, ostatní jako protivník (bez modelu výchozí náhrada). */
export function choiceOf(role, spec) {
  return role.kind === 'player' ? heroChoice(role.label, spec.genre?.id, spec.control) : heroChoice(role.label, undefined, spec.control, 'enemy');
}

/** Podíl výšky plátna, který obdélník (NDC −1…1) na plátně opravdu zabírá. */
export function heightShare(box) {
  if (box == null) return 0;
  return Math.max(0, Math.min(box.maxY, 1) - Math.max(box.minY, -1)) / 2;
}

/** Tělo je v záběru: sonda ho našla, není za kamerou a aspoň kus leží na plátně. */
export function onScreen(box) {
  return box != null && !box.behind && box.maxX > -1 && box.minX < 1 && box.maxY > -1 && box.minY < 1;
}

/** Jedna třída na neviděné slovo; pořadí je pořadí oprav (role → model → záběr → velikost → vzhled). */
export function classify({ carrier, level, box, threshold }) {
  if (carrier === null) return 'no-role';
  if (level === 'fallback') return 'no-model';
  if (!onScreen(box)) return 'off-screen';
  if (threshold !== null && heightShare(box) < threshold) return 'too-small';
  return 'look';
}

/**
 * Řez `share ≥ t` → viděno, který správně zařadí nejvíc bodů; při shodě nižší práh. Práh leží na hodnotě
 * nejmenšího bodu nad řezem.
 */
export function thresholdOf(points) {
  if (points.length === 0) return { threshold: null, correct: 0, of: 0 };
  const shares = [...new Set(points.map((point) => point.share))].sort((a, b) => a - b);
  let best = { threshold: null, correct: -1, of: points.length };
  for (const t of shares) {
    const correct = points.filter((point) => (point.share >= t) === point.visible).length;
    if (correct > best.correct) best = { threshold: t, correct, of: points.length };
  }
  const above = points.filter((point) => point.share >= best.threshold);
  const below = points.filter((point) => point.share < best.threshold);
  return { ...best, seenAbove: above.filter((point) => point.visible).length, above: above.length, seenBelow: below.filter((point) => point.visible).length, below: below.length };
}

/** Slova bez přesného modelu podle počtu vět (pak abecedně), s dnešní volbou modelu. */
export function rankMissing(rows, choose) {
  return rows
    .map((row) => ({ ...row, ...pick(choose(row.noun)) }))
    .filter((row) => row.level !== 'identity')
    .sort((a, b) => b.sentences - a.sentences || a.noun.localeCompare(b.noun));
}

const pick = (choice) => ({ level: choice.level, model: choice.model });

/**
 * Obdélník protivníka či věci: cíl, který sonda vybrala (nejbližší kandidát), jinak největší položka věty.
 * simplified: sonda nevede popisek role, jen druh těla; když cíl kreslí jinou roli než slovo (mince místo
 * protivníka), počítá se její velikost. Upgrade: `userData.label` v těle role a `items` podle popisku.
 */
function otherBox(frame) {
  if (frame == null) return null;
  if (frame.target != null) return frame.target;
  const boxes = Object.values(frame.items ?? {}).map((item) => item.box).filter((item) => item != null);
  return boxes.length === 0 ? null : boxes.reduce((top, item) => (heightShare(item) > heightShare(top) ? item : top));
}

/** Dev sady s popisky a nahraná čtení: odkud se berou podstatná jména pro `missing-nouns.json`. */
const DEV_SETS = ['p56a/audit-12.json', 'p56a/holdout.json', 'p30/dev.json', 'p54c/dev.json', 'p54c/holdout.json', 'p55/holdout.json', 'p43/panel.json'];
/** Každé nahrané čtení P56A a P58A (`evals/play/<plán>/readings/*.json`). */
const READINGS = ['p56a', 'p58a'].flatMap((plan) => readdirSync(join(ROOT, 'evals', 'play', plan, 'readings')).filter((file) => file.endsWith('.json')).map((file) => `${plan}/readings/${file}`));
const DETERMINERS = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'their', 'our', 'some', 'other', 'many', 'lots', 'of', 'two', 'three', 'every', 'all']);

/** Jednotné číslo hlavy popisku; „glass“, „bus“, „cactus“ zůstanou. */
function singularOf(word) {
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ves')) return `${word.slice(0, -3)}f`;
  if (/(?:ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('men')) return `${word.slice(0, -3)}man`;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** Popisek → jméno v jednotném čísle bez členů; prázdný nebo příliš dlouhý (věta, ne jméno) = `null`. */
function nounOf(label) {
  if (typeof label !== 'string') return null;
  const words = wordsOf(label).filter((word) => !DETERMINERS.has(word));
  if (words.length === 0 || words.length > 3) return null;
  return [...words.slice(0, -1), singularOf(words.at(-1))].join(' ');
}

function textsOf(path) {
  const json = readJson(join('evals', 'play', path));
  return (Array.isArray(json) ? json : json.sentences).map((sentence) => sentence.text);
}

/** Kolik vět poptávky a dev sad slovo jmenuje (hlava v kterémkoli tvaru, celá fráze). */
function sentenceCount(noun, texts) {
  const words = noun.split(' ');
  const head = words.at(-1);
  const heads = `(?:${[head, `${head}s`, `${head}es`, head.endsWith('y') ? `${head.slice(0, -1)}ies` : head, head.endsWith('f') ? `${head.slice(0, -1)}ves` : head].join('|')})`;
  const pattern = new RegExp(`\\b${[...words.slice(0, -1), heads].join('\\s+')}\\b`, 'i');
  return texts.filter((text) => pattern.test(text)).length;
}

function missingNouns() {
  const nouns = new Set();
  for (const path of DEV_SETS) {
    for (const sentence of readJson(join('evals', 'play', path)).sentences) for (const key of ['hero', 'foe', 'item']) nouns.add(nounOf(sentence[key]));
  }
  for (const path of READINGS) {
    for (const row of readJson(join('evals', 'play', path)).readings) {
      const reading = row.reading;
      if (reading === null) continue;
      for (const label of [reading.hero, reading.foe, ...(reading.roles ?? []).map((role) => role.noun)]) nouns.add(nounOf(label));
    }
  }
  nouns.delete(null);
  const texts = [...textsOf('demand/corpus.json'), ...DEV_SETS.flatMap(textsOf)];
  const rows = [...nouns].map((noun) => ({ noun, sentences: sentenceCount(noun, texts) })).filter((row) => row.sentences > 0);
  return rankMissing(rows, (noun) => heroChoice(noun, undefined, undefined, 'enemy'));
}

function main() {
  const list = process.argv.slice(2);
  const flag = (name) => {
    const at = list.indexOf(`--${name}`);
    return at === -1 ? undefined : list[at + 1];
  };
  const baseline = readJson(flag('baseline'));
  const frames = new Map(list.flatMap((value, index) => (list[index - 1] === '--frames' ? [value.split('=').reverse()] : [])));
  const nouns = baseline.rows.flatMap((row) => {
    const dir = frames.get(row.set);
    const file = dir === undefined ? null : join(dir, `${row.id}.json`);
    const record = file !== null && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const roles = record?.spec?.roles ?? [];
    return row.nouns.map((item) => {
      const isHero = item.role === 'hero';
      const carrier = record === null ? null : carrierOf(item.noun, isHero, roles);
      const choice = carrier === null ? null : choiceOf(carrier, record.spec);
      const box = isHero ? (record?.frame?.hero ?? null) : otherBox(record?.frame);
      return {
        set: row.set, id: row.id, genre: row.genre, judge: row.judge, noun: item.noun, role: item.role, visible: item.visible, seenAs: item.seenAs,
        measured: record !== null, carrier: carrier === null ? null : `${carrier.kind}:${carrier.label}`, level: choice?.level ?? null, model: choice?.model ?? null,
        onScreen: onScreen(box), share: Math.round(heightShare(box) * 1000) / 1000, box,
      };
    });
  });
  const fitted = (role) => thresholdOf(nouns.filter((item) => item.carrier !== null && item.level !== 'fallback' && item.onScreen && (role === null || item.role === role)).map((item) => ({ share: item.share, visible: item.visible })));
  const thresholds = { hero: fitted('hero'), other: fitted('other'), pooled: fitted(null) };
  const thresholdFor = (role) => thresholds[role].threshold ?? thresholds.pooled.threshold;
  for (const item of nouns) {
    // Věta bez průchodu rozměrů (server spadl) nemá spec ani snímek – třída by byla hádání.
    item.class = item.visible ? null : !item.measured ? 'unmeasured' : classify({ carrier: item.carrier, level: item.level, box: item.onScreen ? item.box : null, threshold: thresholdFor(item.role) });
    delete item.box;
  }
  const unseen = nouns.filter((item) => !item.visible);
  const count = (list) => Object.fromEntries(['no-role', 'no-model', 'off-screen', 'too-small', 'look'].map((name) => [name, list.filter((item) => item.class === name).length]));
  const result = {
    schema: 'p58a-why-unseen.v1',
    baseline: { file: flag('baseline'), commit: baseline.commit },
    classes: 'first match in this order: no-role (no spec role carries the noun), no-model (the role draws the fallback model), off-screen (the role body is behind the camera or off the canvas), too-small (body height on the canvas under the fitted threshold), look (right role, model and size, still not recognised)',
    thresholds,
    measured: nouns.filter((item) => item.measured).length,
    nouns: nouns.length,
    unseen: unseen.length,
    byClass: { all: count(unseen), hero: count(unseen.filter((item) => item.role === 'hero')), other: count(unseen.filter((item) => item.role === 'other')) },
    rows: nouns,
  };
  writeFileSync(resolve(ROOT, flag('out')), `${JSON.stringify(result, null, 1)}\n`);
  console.log(`why: ${unseen.length} unseen of ${nouns.length} nouns (${result.measured} measured); ${JSON.stringify(result.byClass.all)}`);
  console.log(`thresholds: hero ${JSON.stringify(thresholds.hero)}, other ${JSON.stringify(thresholds.other)}`);
  const missing = missingNouns();
  writeFileSync(resolve(ROOT, flag('missing')), `{\n "about": "P58A T2: nouns from dev-set labels (hero/foe/item) and recorded gpt-oss-20b readings that the catalog has no exact model for (heroChoice level != identity), ranked by the number of sentences naming them in evals/play/demand/corpus.json and the dev sets. Written by scripts/p58a/why-unseen.mjs.",\n "nouns": [\n${missing.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n ]\n}\n`);
  console.log(`missing nouns: ${missing.length}; top 10 ${missing.slice(0, 10).map((row) => `${row.noun}(${row.sentences},${row.level})`).join(' ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
