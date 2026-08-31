#!/usr/bin/env node
/**
 * Zámek zmrazené worldstream sady (P13 T8).
 *
 * `create.jsonl` (30 vět) a `refine.jsonl` (20 změn) vznikly **dřív, než se nad
 * nimi cokoli změřilo a dřív, než existoval compiler**. To druhé je celý důvod,
 * proč se sada mrazí právě teď: korpus napsaný až po compileru by potvrzoval
 * jeho vlastní slovník místo toho, aby ho soudil.
 *
 * ## Co tenhle zámek NEUMÍ, a nikde se to nesmí tvrdit
 *
 * **Zmrazení není vynutitelné.** Kdo má přístup do repozitáře, korpus po
 * naměření přepíše a sadu nechá zelenou — pět nezávislých revizí to nad P11
 * předvedlo a pátá obešla i hash lock přes `git replace`, s prázdným
 * `git status` i `git diff` (`CLAUDE.md`, rozpor 1). Tenhle soubor je proto
 * **záznam, ne ochrana**: dělá tichou změnu hlučnou, nedělá ji nemožnou.
 * Do přihlášky, reportu ani `DISCLOSURE.md` se vynutitelnost napsat nesmí.
 *
 * ## Tři režimy
 *
 *   node evals/worldstream/lock.mjs             zamkne; když zámek už existuje, ODMÍTNE
 *   node evals/worldstream/lock.mjs --verify    jen ověří, nic nezapíše (exit 1 při nesouhlasu)
 *   node evals/worldstream/lock.mjs --refreeze  přepíše zámek, vyžaduje --reason
 *
 * ## Co manifest kryje a co schválně ne
 *
 * Jmenovitě `create.jsonl` a `refine.jsonl`, plus pravidlo, že v adresáři nesmí
 * ležet **žádný další `.jsonl`** mimo manifest — jinak by šlo korpus rozšířit
 * o data, která zámek nevidí. Zbytek adresáře se schválně nehashuje: T14 sem
 * zapisuje `create-report.json` při každém běhu a `measure-create.ts` je
 * měřidlo, ne korpus. Kdyby se hashovaly, `refrozenAt` by přestal odpovídat na
 * jedinou otázku, kvůli které existuje — **hnul někdo prompty po měření?**
 *
 * ## Co se kontroluje kromě hashů
 *
 * Zamknout vadný korpus znamená zabetonovat vadu, takže zámek certifikuje i tvar:
 *
 *   1. přesně 30 create a 20 refine záznamů, unikátní `id` i věty
 *   2. rozdělení kategorií a druhů změn sedí na to, co předepisuje plán
 *   3. každý create případ nese ručně zapsané povinnosti: prostorovou tezi,
 *      hrdinské objekty, viditelný beat a aspoň dvě nepřípustné substituce
 *   4. `out_of_category` musí pojmenovat, co systém odmítl (`mustName`) — jinak
 *      by prompt mimo focus kategorii prošel tichým předstíráním
 *   5. každý refine cílí na `createId`, který existuje, a jmenuje objekt
 *      **ze seznamu hrdinských objektů toho případu** — bez téhle křížové
 *      reference by refine sada mohla mluvit o světě, který v create sadě není
 *   6. `shape_only` / `behavior_only` / `appearance_only` mají přesně jednu osu,
 *      `mixed` aspoň dvě, `ambiguous_target` žádnou a aspoň dva kandidáty
 *   7. **nikde se nesmí objevit slovník implementace** — viz `FORBIDDEN_VOCABULARY`
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const CREATE_FILE = 'create.jsonl';
export const REFINE_FILE = 'refine.jsonl';
export const MANIFEST_FILE = 'MANIFEST.lock';

/** Soubory, které jsou korpus. Cokoli jiného v adresáři je nástroj nebo výstup. */
export const FROZEN_FILES = Object.freeze([CREATE_FILE, REFINE_FILE]);

/** Rozdělení create sady z plánu P13 T8. Součet je 30 a je to jediné povolené rozdělení. */
export const CREATE_DISTRIBUTION = Object.freeze({
  architecture: 6,
  organic: 5,
  mechanism: 5,
  atmosphere: 5,
  abstract: 4,
  out_of_category: 5,
});

/** Rozdělení refine sady. Součet je 20. */
export const REFINE_DISTRIBUTION = Object.freeze({
  shape_only: 5,
  behavior_only: 4,
  appearance_only: 4,
  mixed: 4,
  ambiguous_target: 3,
});

export const CREATE_TOTAL = Object.values(CREATE_DISTRIBUTION).reduce((a, b) => a + b, 0);
export const REFINE_TOTAL = Object.values(REFINE_DISTRIBUTION).reduce((a, b) => a + b, 0);

/** Osy, na kterých druhá věta smí něco změnit. */
export const SCOPE_AXES = Object.freeze(['shape', 'behavior', 'appearance']);

/** Druh změny → přesný počet os, které smí nést. `null` znamená „aspoň dvě". */
const SCOPE_ARITY = Object.freeze({
  shape_only: 1,
  behavior_only: 1,
  appearance_only: 1,
  mixed: null,
  ambiguous_target: 0,
});

/** Druh změny → osa, kterou musí nést, když je jednoosý. */
const SINGLE_AXIS = Object.freeze({
  shape_only: 'shape',
  behavior_only: 'behavior',
  appearance_only: 'appearance',
});

/**
 * Slovník, kterým korpus mluvit nesmí. Tohle je celý důvod, proč se sada mrazí
 * **před** compilerem: kdyby povinnosti byly psané v pojmech, které compiler
 * emituje, sada by ho neměřila, jen recitovala. Věta porotce zní „udělej klenbu",
 * ne „emituj `revolve`", a korpus musí být psaný v tom prvním jazyce.
 */
export const FORBIDDEN_VOCABULARY = Object.freeze([
  'shapeprogram',
  'geomprogram',
  'worlddoc',
  'semanticobject',
  'intentsummary',
  'meshartifact',
  'semanticslot',
  'stableid',
  'interactionsockets',
  'choosefamily',
  'blueprint',
  'sdf',
  'signed distance',
  'revolve',
]);

/**
 * Hash se počítá nad obsahem normalizovaným na LF. Bez toho by tentýž soubor dal
 * na Windows jiný hash než na Linuxu. Repo to vynucuje i gitem (`.gitattributes`);
 * tohle je druhá vrstva.
 */
export function normalisedSha256(absolutePath) {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
}

/** Každý `.jsonl` v adresáři, rekurzivně. Manifest musí krýt přesně tuhle množinu. */
export function jsonlRelativePaths(dir = CORPUS_DIR) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith('.jsonl')) out.push(relative(dir, abs).split(sep).join(posix.sep));
    }
  };
  walk(dir);
  return out.sort();
}

/** Řádek po řádku, s číslem řádku u každé vady. Prázdné řádky se přeskakují. */
function readJsonl(absolutePath) {
  const text = readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
  const records = [];
  const problems = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      problems.push(`${posix.basename(absolutePath.split(sep).join(posix.sep))}:${index + 1}: ${error.message}`);
    }
  });
  return { records, problems };
}

export function readCorpus(dir = CORPUS_DIR) {
  const create = readJsonl(join(dir, CREATE_FILE));
  const refine = readJsonl(join(dir, REFINE_FILE));
  return {
    create: create.records,
    refine: refine.records,
    parseProblems: [...create.problems, ...refine.problems],
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value, minimum) {
  return Array.isArray(value) && value.length >= minimum && value.every(nonEmptyString);
}

/** Každý řetězec záznamu, ať leží kdekoli — do kontroly slovníku jdou všechny. */
function everyString(value, sink = []) {
  if (typeof value === 'string') sink.push(value);
  else if (Array.isArray(value)) for (const item of value) everyString(item, sink);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) everyString(item, sink);
  return sink;
}

function vocabularyProblems(id, record) {
  const problems = [];
  for (const text of everyString(record)) {
    const lower = text.toLowerCase();
    for (const term of FORBIDDEN_VOCABULARY) {
      // Hranice slova, aby `sdf` netrefil uvnitř jiného slova a `revolve`
      // neshodil legitimní `revolving`.
      const pattern = new RegExp(`(^|[^a-z0-9])${term.replace(/ /g, '\\s+')}($|[^a-z0-9])`);
      if (pattern.test(lower)) problems.push(`${id}: mluví slovníkem implementace ("${term}")`);
    }
  }
  return problems;
}

function countBy(records, key) {
  const counts = {};
  for (const record of records) counts[record?.[key]] = (counts[record?.[key]] ?? 0) + 1;
  return counts;
}

function distributionProblems(counts, expected, label) {
  const problems = [];
  for (const [bucket, want] of Object.entries(expected)) {
    const have = counts[bucket] ?? 0;
    if (have !== want) problems.push(`${label} ${bucket}: ${have} záznamů, čekalo se ${want}`);
  }
  for (const bucket of Object.keys(counts)) {
    if (!(bucket in expected)) problems.push(`${label} ${bucket} není v předepsaném rozdělení`);
  }
  return problems;
}

/** Vrací pole vět popisujících nálezy. Prázdné pole znamená, že je korpus v pořádku. */
export function validateCorpus(corpus) {
  const problems = [...(corpus?.parseProblems ?? [])];
  const create = corpus?.create;
  const refine = corpus?.refine;

  if (!Array.isArray(create) || !Array.isArray(refine)) return [...problems, 'korpus nemá obě pole záznamů'];

  if (create.length !== CREATE_TOTAL) problems.push(`create: ${create.length} záznamů, čekalo se ${CREATE_TOTAL}`);
  if (refine.length !== REFINE_TOTAL) problems.push(`refine: ${refine.length} záznamů, čekalo se ${REFINE_TOTAL}`);

  const heroesById = new Map();
  const seenIds = new Set();
  const seenPrompts = new Map();

  for (const record of create) {
    const id = record?.id;
    if (!nonEmptyString(id)) {
      problems.push('create: záznam bez `id`');
      continue;
    }
    if (seenIds.has(id)) problems.push(`${id}: duplicitní id`);
    seenIds.add(id);

    if (!nonEmptyString(record.prompt)) problems.push(`${id}: prázdná věta`);
    else if (seenPrompts.has(record.prompt)) problems.push(`${id}: stejná věta jako ${seenPrompts.get(record.prompt)}`);
    else seenPrompts.set(record.prompt, id);

    if (!nonEmptyString(record.spatialThesis)) problems.push(`${id}: chybí prostorová teze`);
    if (!nonEmptyString(record.visibleBeat)) problems.push(`${id}: chybí viditelný beat`);
    if (!stringArray(record.heroObjects, 1)) problems.push(`${id}: chybí hrdinské objekty`);
    else if (new Set(record.heroObjects).size !== record.heroObjects.length) {
      problems.push(`${id}: duplicitní hrdinský objekt`);
    }
    // Dvě, ne jedna: jediná pojmenovaná substituce je jedna past, dvě jsou
    // třída. Povinnost, kterou jde splnit obejitím jediné věty, nic nesoudí.
    if (!stringArray(record.forbiddenSubstitutions, 2)) {
      problems.push(`${id}: potřebuje aspoň dvě nepřípustné substituce`);
    }
    if (!Array.isArray(record.mustName) || !record.mustName.every(nonEmptyString)) {
      problems.push(`${id}: mustName musí být pole neprázdných vět`);
    } else if (record.category === 'out_of_category' && record.mustName.length === 0) {
      problems.push(`${id}: out_of_category musí pojmenovat, co systém odmítl`);
    }

    problems.push(...vocabularyProblems(id, record));
    if (Array.isArray(record.heroObjects)) heroesById.set(id, new Set(record.heroObjects));
  }

  problems.push(...distributionProblems(countBy(create, 'category'), CREATE_DISTRIBUTION, 'kategorie'));

  const seenRefineIds = new Set();
  for (const record of refine) {
    const id = record?.id;
    if (!nonEmptyString(id)) {
      problems.push('refine: záznam bez `id`');
      continue;
    }
    if (seenRefineIds.has(id)) problems.push(`${id}: duplicitní id`);
    seenRefineIds.add(id);

    if (!nonEmptyString(record.prompt)) problems.push(`${id}: prázdná věta`);
    if (!stringArray(record.mustNotChange, 1)) problems.push(`${id}: chybí, co se změnit nesmí`);

    const heroes = heroesById.get(record?.createId);
    if (!heroes) {
      problems.push(`${id}: createId "${record?.createId}" v create sadě neexistuje`);
      continue;
    }

    const arity = SCOPE_ARITY[record.kind];
    if (arity === undefined) {
      problems.push(`${id}: druh změny "${record.kind}" není ze slovníku`);
      continue;
    }
    if (!Array.isArray(record.scope) || record.scope.some((axis) => !SCOPE_AXES.includes(axis))) {
      problems.push(`${id}: scope obsahuje osu mimo slovník`);
    } else if (arity === null) {
      if (record.scope.length < 2) problems.push(`${id}: mixed musí měnit aspoň dvě osy`);
    } else if (record.scope.length !== arity) {
      problems.push(`${id}: ${record.kind} musí mít přesně ${arity} os, má ${record.scope.length}`);
    } else if (arity === 1 && record.scope[0] !== SINGLE_AXIS[record.kind]) {
      problems.push(`${id}: ${record.kind} musí měnit osu ${SINGLE_AXIS[record.kind]}`);
    }

    if (record.kind === 'ambiguous_target') {
      if (record.targetObject !== null) problems.push(`${id}: nejasný cíl nesmí jmenovat objekt`);
      if (!stringArray(record.candidates, 2)) problems.push(`${id}: nejasný cíl potřebuje aspoň dva kandidáty`);
      else {
        for (const candidate of record.candidates) {
          if (!heroes.has(candidate)) problems.push(`${id}: kandidát "${candidate}" není hrdinský objekt ${record.createId}`);
        }
      }
    } else {
      if (record.candidates !== undefined) problems.push(`${id}: kandidáty smí nést jen nejasný cíl`);
      // Křížová reference. Bez ní by refine sada mohla mluvit o objektu, který
      // v žádném create případu není, a nikdo by si toho nevšiml.
      if (!nonEmptyString(record.targetObject)) problems.push(`${id}: chybí cílový objekt`);
      else if (!heroes.has(record.targetObject)) {
        problems.push(`${id}: cíl "${record.targetObject}" není hrdinský objekt ${record.createId}`);
      }
    }

    problems.push(...vocabularyProblems(id, record));
  }

  problems.push(...distributionProblems(countBy(refine, 'kind'), REFINE_DISTRIBUTION, 'druh změny'));

  return problems;
}

export function computeFileHashes(dir = CORPUS_DIR) {
  const files = {};
  for (const rel of FROZEN_FILES) files[rel] = normalisedSha256(join(dir, rel));
  return files;
}

export function readManifest(dir = CORPUS_DIR) {
  return JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
}

/** Vrací pole vět popisujících nesouhlas manifestu se stromem. Prázdné pole = sedí. */
export function verifyAgainstManifest(dir = CORPUS_DIR) {
  const problems = [];
  const manifest = readManifest(dir);

  for (const [rel, hash] of Object.entries(manifest.files)) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) problems.push(`${rel}: v manifestu je, ve stromu chybí`);
    else if (normalisedSha256(abs) !== hash) problems.push(`${rel}: hash nesouhlasí se zamčeným`);
  }
  for (const rel of jsonlRelativePaths(dir)) {
    if (!(rel in manifest.files)) problems.push(`${rel}: data ve stromu, která manifest nekryje`);
  }
  return problems;
}

function buildManifest(previous, reason) {
  return {
    lockVersion: 1,
    corpusVersion: 'worldstream-v1',
    algorithm: 'sha256',
    normalization:
      'CRLF -> LF před hashováním. Bez toho by hash téhož souboru závisel na tom, na jakém stroji se repo checkoutovalo.',
    coverageRule:
      'Manifest kryje jmenovitě create.jsonl a refine.jsonl. Navíc nesmí v evals/worldstream/ ležet žádný další .jsonl mimo manifest — jinak by šlo korpus rozšířit o data, která zámek nevidí. Zbytek adresáře (zámek, testy, měřidlo z T14, create-report.json) se schválně nehashuje: report se přepisuje při každém běhu a refrozenAt by přestal odpovídat na jedinou otázku, kvůli které existuje.',
    enforceabilityNote:
      'Tenhle zámek zmrazení NEVYNUCUJE a nikde se to tvrdit nesmí. Kdo má přístup do repozitáře, korpus po naměření přepíše a sadu nechá zelenou; nad P11 to předvedlo pět nezávislých revizí a jedna obešla i hash lock přes git replace, s prázdným git status. Zámek dělá tichou změnu hlučnou, ne nemožnou.',
    frozenBefore:
      'planner, compiler i jakékoli měření nad touhle sadou. V okamžiku zápisu tohohle manifestu neexistoval src/model/worldstream-compiler.ts ani evals/worldstream/create-report.json.',
    vocabularyRule:
      'Žádná věta ani povinnost nesmí mluvit slovníkem implementace (FORBIDDEN_VOCABULARY v lock.mjs). Korpus psaný v pojmech, které compiler emituje, by ho nesoudil, jen recitoval — a to je celý důvod, proč se mrazí právě teď.',
    writtenBy: 'P13 T8 (plans/P13-worldstream.md)',
    ...(reason ? { refrozenAt: { reason } } : {}),
    ...(previous?.refrozenAt && !reason ? { refrozenAt: previous.refrozenAt } : {}),
    files: computeFileHashes(),
  };
}

function fail(header, problems) {
  console.error(`\n${header}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

function main(argv) {
  const verifyOnly = argv.includes('--verify');
  const refreeze = argv.includes('--refreeze');
  const reasonIndex = argv.indexOf('--reason');
  const reason = reasonIndex >= 0 ? argv[reasonIndex + 1] : undefined;
  const manifestPath = join(CORPUS_DIR, MANIFEST_FILE);

  const corpusProblems = validateCorpus(readCorpus());
  if (corpusProblems.length) fail('worldstream: korpus má vadný tvar, zamykat se nesmí', corpusProblems);

  if (verifyOnly) {
    if (!existsSync(manifestPath)) fail('worldstream: MANIFEST.lock neexistuje', ['sada ještě není zamčená']);
    const drift = verifyAgainstManifest();
    if (drift.length) fail('worldstream: strom se rozešel se zamčeným manifestem', drift);
    console.log(`worldstream: ${CREATE_TOTAL} vět, ${REFINE_TOTAL} změn, zámek sedí`);
    return;
  }

  if (existsSync(manifestPath) && !refreeze) {
    fail('worldstream: zámek už existuje a přepsat se sám od sebe nesmí', [
      'ověření: node evals/worldstream/lock.mjs --verify',
      'přemrazení: node evals/worldstream/lock.mjs --refreeze --reason "<proč>"',
    ]);
  }
  if (refreeze && !(reason && reason.trim())) {
    fail('worldstream: --refreeze vyžaduje --reason', ['přemrazení bez zapsaného důvodu je tichý přepis']);
  }

  const previous = existsSync(manifestPath) ? readManifest() : undefined;
  const manifest = buildManifest(previous, refreeze ? reason : undefined);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`worldstream: zamčeno ${Object.keys(manifest.files).length} souborů, ${CREATE_TOTAL} vět, ${REFINE_TOTAL} změn`);
  for (const [rel, hash] of Object.entries(manifest.files)) console.log(`  ${hash.slice(0, 12)}  ${rel}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
