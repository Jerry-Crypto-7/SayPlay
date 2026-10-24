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
 * zvlášť hrdina (X pro T3) a protivník či věc (Y) – a platí jen, když velikost viděná a neviděná slova opravdu
 * dělí (`thresholdOf`); vedle něj pásma výšky. Vedle toho `missing-nouns.json`: podstatná jména z popisků dev sad
 * a z nahraných čtení bez ne-jmen (`thingOf`), která katalog nemá přesně (`level` ≠ `identity`), podle počtu vět
 * v poptávce a dev sadách.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/p58a/why-unseen.mjs --baseline evals/play/p58a/baseline.json \
 *     --frames <adresář>=<sada.json> [--frames …] --out evals/play/p58a/why.json --missing evals/play/p58a/missing-nouns.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { heroChoice } from '../../src/play/arcade/models.ts';
import { singular } from '../../src/play/draft/lexicon.ts';
import { normal, parseNotNouns } from '../p37d/missing-nouns.mjs';

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

/** Slova, kterými soudce popisuje tělo jako malé nebo vzdálené. */
const SMALL = /\b(?:small|tiny|distant|far|little|miniature)\b/i;
const SMALL_EDGES = [0.1, 0.15, 0.2, 0.25, 0.3];

/** Pásma výšky na plátně pro tabulku „kolik soudce poznal“ – podle nich se čte, jestli velikost vůbec hraje roli. */
const BAND_EDGES = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1.01];

export function bandsOf(points) {
  return BAND_EDGES.slice(0, -1).map((from, index) => {
    const inside = points.filter((point) => point.share >= from && point.share < BAND_EDGES[index + 1]);
    return { from, to: Math.min(BAND_EDGES[index + 1], 1), seen: inside.filter((point) => point.visible).length, of: inside.length };
  });
}

/**
 * Řez `share ≥ t` → viděno, který správně zařadí nejvíc bodů a nechá aspoň `min` bodů na každé straně; při shodě
 * nižší práh (hodnota nejmenšího bodu nad řezem). Práh platí, jen když soudce nad ním poznává aspoň polovinu a
 * aspoň dvakrát častěji než pod ním – jinak velikost viděná a neviděná slova nedělí a `threshold` je `null`
 * (nejlepší řez zůstane v `cut` pro kontrolu).
 */
export function thresholdOf(points, min = 3) {
  const bands = bandsOf(points);
  const seenOf = (list) => list.filter((point) => point.visible).length;
  const shares = [...new Set(points.map((point) => point.share))].sort((a, b) => a - b);
  let cut = null;
  for (const t of shares) {
    const above = points.filter((point) => point.share >= t);
    const below = points.filter((point) => point.share < t);
    if (above.length < min || below.length < min) continue;
    const correct = seenOf(above) + below.length - seenOf(below);
    if (cut === null || correct > cut.correct) cut = { at: t, correct, seenAbove: seenOf(above), above: above.length, seenBelow: seenOf(below), below: below.length };
  }
  const holds = cut !== null && cut.seenAbove / cut.above >= 0.5 && cut.seenAbove / cut.above >= (2 * cut.seenBelow) / cut.below;
  return { threshold: holds ? cut.at : null, of: points.length, seen: seenOf(points), cut, bands };
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

/** Popisek → jméno v jednotném čísle (lexikon draftu: „zombies“, „walruses“, „cyclops“) bez členů; prázdný nebo příliš dlouhý (věta, ne jméno) = `null`. */
function nounOf(label) {
  if (typeof label !== 'string') return null;
  const words = wordsOf(label).filter((word) => !DETERMINERS.has(word));
  if (words.length === 0 || words.length > 3) return null;
  return singular(words.join(' '));
}

/**
 * Jméno věci, kterou jde nakreslit: bez slov ze seznamu ne-jmen (`ops/gen3d/not-nouns.txt` – zájmena, slovesa,
 * číslovky, přídavná jména, místa); když na seznamu je hlava („you“, „city“, „big city“), věc to není = `null`.
 */
export function thingOf(noun, notNouns) {
  const words = noun.split(' ');
  if (notNouns.has(noun) || notNouns.has(words.at(-1))) return null;
  return words.filter((word) => !notNouns.has(word)).join(' ');
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
  // Ne-jména a abstrakta („tax“, „date“, „gap“) jako P37D; abstraktní fráze jen celé.
  const notNouns = parseNotNouns(readFileSync(join(ROOT, 'ops', 'gen3d', 'not-nouns.txt'), 'utf8'));
  for (const word of readJson('evals/play/p37d/common-nouns.json').abstract.map(normal)) notNouns.add(word);
  const texts = [...textsOf('demand/corpus.json'), ...DEV_SETS.flatMap(textsOf)];
  const kept = new Set([...nouns].map((noun) => thingOf(noun, notNouns)).filter((noun) => noun !== null));
  const rows = [...kept].map((noun) => ({ noun, sentences: sentenceCount(noun, texts) })).filter((row) => row.sentences > 0);
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
  // Práh zvlášť pro hrdinu a pro protivníka či věc; role, kde velikost nic nedělí, nemá žádné `too-small`.
  const sized = (role) => nouns.filter((item) => item.carrier !== null && item.level !== 'fallback' && item.onScreen && item.role === role);
  const thresholds = { hero: thresholdOf(sized('hero')), other: thresholdOf(sized('other')) };
  // Kolikrát soudce sám píše, že je tělo malé, pod a nad hranou výšky – podklad pro X a Y v T3, když práh poznání nevyjde.
  const called = (list) => ({ small: list.filter((item) => SMALL.test(item.seenAs ?? '')).length, of: list.length });
  const calledSmall = Object.fromEntries(['hero', 'other'].map((role) => [role, SMALL_EDGES.map((edge) => ({ edge, below: called(sized(role).filter((item) => item.share < edge)), above: called(sized(role).filter((item) => item.share >= edge)) }))]));
  for (const item of nouns) {
    // Věta bez průchodu rozměrů (server spadl) nemá spec ani snímek – třída by byla hádání.
    item.class = item.visible ? null : !item.measured ? 'unmeasured' : classify({ carrier: item.carrier, level: item.level, box: item.onScreen ? item.box : null, threshold: thresholds[item.role].threshold });
    delete item.box;
  }
  const unseen = nouns.filter((item) => !item.visible);
  const count = (list) => Object.fromEntries(['no-role', 'no-model', 'off-screen', 'too-small', 'look', 'unmeasured'].map((name) => [name, list.filter((item) => item.class === name).length]));
  const tally = (list, key) => list.reduce((out, item) => ({ ...out, [item[key]]: (out[item[key]] ?? 0) + 1 }), {});
  const looked = unseen.filter((item) => item.class === 'look');
  const result = {
    schema: 'p58a-why-unseen.v1',
    baseline: { file: flag('baseline'), commit: baseline.commit },
    classes: 'first match in this order: no-role (no spec role carries the noun), no-model (the role draws the fallback model), off-screen (the role body is behind the camera or off the canvas), too-small (body height on the canvas under the fitted threshold; none when size does not separate seen from unseen), look (right role, model and size, still not recognised)',
    thresholds,
    measured: nouns.filter((item) => item.measured).length,
    nouns: nouns.length,
    unseen: unseen.length,
    byClass: { all: count(unseen), hero: count(unseen.filter((item) => item.role === 'hero')), other: count(unseen.filter((item) => item.role === 'other')) },
    // `look` podle úrovně modelu: `identity` je přesný model, ostatní je blízká náhrada (jiné zvíře, jiná věc).
    lookByLevel: tally(looked, 'level'),
    // Kolikrát soudce u `look` sám píše, že je tělo malé nebo daleko – velikost bez čistého prahu, ale ne bez vlivu.
    lookCalledSmall: called(looked).small,
    calledSmall,
    rows: nouns,
  };
  writeFileSync(resolve(ROOT, flag('out')), `${JSON.stringify(result, null, 1)}\n`);
  console.log(`why: ${unseen.length} unseen of ${nouns.length} nouns (${result.measured} measured); ${JSON.stringify(result.byClass.all)}; look by level ${JSON.stringify(result.lookByLevel)}`);
  for (const role of ['hero', 'other']) console.log(`${role}: threshold ${thresholds[role].threshold}, seen ${thresholds[role].seen}/${thresholds[role].of}, cut ${JSON.stringify(thresholds[role].cut)}, bands ${thresholds[role].bands.map((band) => `${band.from}-${band.to}:${band.seen}/${band.of}`).join(' ')}`);
  const missing = missingNouns();
  writeFileSync(resolve(ROOT, flag('missing')), `{\n "about": "P58A T2: nouns from dev-set labels (hero/foe/item) and recorded gpt-oss-20b readings that the catalog has no exact model for (heroChoice level != identity), ranked by the number of sentences naming them in evals/play/demand/corpus.json and the dev sets. Written by scripts/p58a/why-unseen.mjs.",\n "nouns": [\n${missing.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n ]\n}\n`);
  console.log(`missing nouns: ${missing.length}; top 10 ${missing.slice(0, 10).map((row) => `${row.noun}(${row.sentences},${row.level})`).join(' ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
