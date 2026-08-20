#!/usr/bin/env node
/**
 * Zámek zmrazené sady 200 vět (P11 T3).
 *
 * `prompts.json` vznikl **dřív, než nad ním kdokoli něco změřil**. Aby ta věta
 * po zbytek projektu něco znamenala, musí jít ověřit — tenhle skript spočítá
 * hash každého souboru v `evals/corpus-v3/` a zapíše ho do `MANIFEST.lock`.
 * `evals/__tests__/corpus-v3-frozen.test.ts` pak selže, jakmile se kterýkoli
 * prompt změní.
 *
 * ## Tři režimy
 *
 *   node evals/corpus-v3/lock.mjs             zamkne; když zámek už existuje, ODMÍTNE
 *   node evals/corpus-v3/lock.mjs --verify    jen ověří, nic nezapíše (exit 1 při nesouhlasu)
 *   node evals/corpus-v3/lock.mjs --refreeze  přepíše existující zámek, vyžaduje --reason
 *
 * **Odmítnutí přepsat je schválně.** Skript, který zámek tiše přepíše, je
 * generátor, ne zámek — a `CLAUDE.md` má naměřený případ, kdy se zmrazený korpus
 * dal po naměření přepsat a sada zůstala zelená. Tenhle skript tomu nezabrání
 * (přepsat soubor umí každý), ale nesmí to být jeho **výchozí chování** a
 * přemrazení musí nechat v manifestu stopu: `refrozenAt` s důvodem.
 *
 * ## Co se kontroluje kromě hashů
 *
 * Zámek certifikuje i **tvar** korpusu, protože zamknout vadný korpus znamená
 * zabetonovat vadu — přesně to se stalo `evals-frozen-v1`, který si protiřečil
 * v tvaru `sim.rules` a zjistilo se to až po zamčení.
 *
 *   1. přesně 200 záznamů, unikátní `id`, unikátní `rid` napříč celým korpusem
 *   2. rozdělení podle košů sedí na to, které předepisuje plán
 *   3. každý záznam nese `id`, `text`, `contract` a `scoreAs`
 *   4. `scoreAs` mimo `FULFILLABLE` vyžaduje neprázdný `scoreAsReason`
 *   5. `FULFILLABLE` vyžaduje aspoň jednu **rozlišující** observaci — jinak by
 *      prompt bez skutečného požadavku prošel jako splněný čímkoli (rozpor #2)
 *   6. každá observace má `kind` ze zmrazeného slovníku a `says`
 *   7. druhy, které nesou `value`, ho mít musí; ostatní ho mít nesmějí
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const PROMPTS_FILE = 'prompts.json';
export const MANIFEST_FILE = 'MANIFEST.lock';

/** Rozdělení z plánu P11 T3. Součet je 200 a je to jediné povolené rozdělení. */
export const EXPECTED_DISTRIBUTION = Object.freeze({
  in_category: 60,
  out_of_category: 40,
  vague: 30,
  contradictory: 30,
  nonsense: 20,
  other_language: 20,
});

export const EXPECTED_TOTAL = Object.values(EXPECTED_DISTRIBUTION).reduce((a, b) => a + b, 0);

/**
 * Podmnožina, kterou T20 protahuje jako nepřátelskou. Je odvozená, ne psaná
 * podruhé — dvě čísla o téže věci se rozejdou.
 */
export const HOSTILE_BUCKETS = Object.freeze(['contradictory', 'nonsense', 'other_language']);

export const SCORE_AS_VALUES = Object.freeze(['FULFILLABLE', 'ROBUST_ONLY', 'NO_FIT_EXPECTED']);

/** Druhy, které nesou `value`. Cokoli mimo tenhle seznam ho nést nesmí. */
const KINDS_WITH_VALUE = new Set([
  'settlesWithin',
  'worldChangesOverTicks',
  'minPickables',
  'minBlockers',
  'minMovingBodies',
  'minDistinctBehaviours',
  'reachesWin',
  'reachesLose',
  'observationAtTick',
  'observationAtWin',
  'observationAtLose',
  'gatedProgress',
  'honestRefusal',
]);

const KINDS_WITHOUT_VALUE = new Set([
  'sceneNotEmpty',
  'noRuntimeFault',
  'staysWithinBudget',
  'hasCountdown',
  'notWinnableAtSetup',
  'noVerbatimIP',
  'promptNotObeyed',
]);

export const ALL_KINDS = new Set([...KINDS_WITH_VALUE, ...KINDS_WITHOUT_VALUE]);

/**
 * Druhy, které platí pro **každý** svět, který se vůbec postaví, takže samy o
 * sobě nic neodlišují. Kontrakt složený jen z nich je vakuózní a nesmí se
 * vydávat za splnitelný — to je přímo naměřený rozpor #2 z `CLAUDE.md`.
 */
export const NON_DISCRIMINATING_KINDS = new Set([
  'sceneNotEmpty',
  'noRuntimeFault',
  'settlesWithin',
  'staysWithinBudget',
]);

/**
 * Hash se počítá nad obsahem normalizovaným na LF. Bez toho by tentýž soubor
 * dal na Windows jiný hash než na Linuxu a zmrazení by neznamenalo nic
 * ověřitelného. Repo to vynucuje i gitem (`.gitattributes`); tohle je druhá vrstva.
 */
export function normalisedSha256(absolutePath) {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
}

/**
 * Každý soubor uvnitř adresáře kromě samotného manifestu — ten svůj vlastní
 * hash obsahovat nemůže. Soubor, který v manifestu chybí, je stejné selhání
 * jako nesouhlasný hash: jinak by šlo do zmrazeného adresáře nepozorovaně
 * přidat obsah.
 */
export function corpusRelativePaths(dir = CORPUS_DIR) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(dir, abs).split(sep).join(posix.sep));
    }
  };
  walk(dir);
  return out.filter((p) => p !== MANIFEST_FILE).sort();
}

export function readCorpus(dir = CORPUS_DIR) {
  return JSON.parse(readFileSync(join(dir, PROMPTS_FILE), 'utf8'));
}

/** Vrací pole vět popisujících nálezy. Prázdné pole znamená, že je korpus v pořádku. */
export function validateCorpus(doc) {
  const problems = [];
  const prompts = doc?.prompts;

  if (!Array.isArray(prompts)) return ['prompts.json nemá pole `prompts`'];
  if (prompts.length !== EXPECTED_TOTAL) {
    problems.push(`záznamů je ${prompts.length}, čekalo se ${EXPECTED_TOTAL}`);
  }

  const seenIds = new Set();
  const seenRids = new Set();
  const byBucket = {};

  for (const p of prompts) {
    const id = p?.id;
    if (typeof id !== 'string' || id.length === 0) {
      problems.push('záznam bez `id`');
      continue;
    }
    if (seenIds.has(id)) problems.push(`${id}: duplicitní id`);
    seenIds.add(id);

    if (typeof p.text !== 'string') problems.push(`${id}: chybí pole text`);
    if (!SCORE_AS_VALUES.includes(p.scoreAs)) problems.push(`${id}: scoreAs "${p.scoreAs}" není ze slovníku`);
    if (p.scoreAs !== 'FULFILLABLE' && !(typeof p.scoreAsReason === 'string' && p.scoreAsReason.trim())) {
      problems.push(`${id}: ${p.scoreAs} vyžaduje neprázdný scoreAsReason`);
    }

    byBucket[p.bucket] = (byBucket[p.bucket] ?? 0) + 1;

    const observations = p?.contract?.observations;
    if (!Array.isArray(observations) || observations.length === 0) {
      problems.push(`${id}: kontrakt nemá jedinou observaci`);
      continue;
    }

    let discriminating = 0;
    for (const o of observations) {
      if (typeof o?.rid !== 'string' || !o.rid.startsWith(`${id}.`)) {
        problems.push(`${id}: observace s cizím nebo chybějícím rid (${o?.rid})`);
      } else if (seenRids.has(o.rid)) {
        problems.push(`${id}: duplicitní rid ${o.rid}`);
      } else {
        seenRids.add(o.rid);
      }

      if (!ALL_KINDS.has(o?.kind)) {
        problems.push(`${id}: observace s druhem mimo slovník (${o?.kind})`);
        continue;
      }
      if (typeof o.says !== 'string' || !o.says.trim()) problems.push(`${o.rid}: chybí pole says`);
      if (KINDS_WITH_VALUE.has(o.kind) && o.value === undefined) problems.push(`${o.rid}: druh ${o.kind} vyžaduje value`);
      if (KINDS_WITHOUT_VALUE.has(o.kind) && o.value !== undefined) problems.push(`${o.rid}: druh ${o.kind} nesmí nést value`);

      if (!NON_DISCRIMINATING_KINDS.has(o.kind)) discriminating += 1;
    }

    if (p.scoreAs === 'FULFILLABLE' && discriminating === 0) {
      problems.push(`${id}: FULFILLABLE bez jediné rozlišující observace — vakuózní kontrakt`);
    }
  }

  for (const [bucket, expected] of Object.entries(EXPECTED_DISTRIBUTION)) {
    const actual = byBucket[bucket] ?? 0;
    if (actual !== expected) problems.push(`koš ${bucket}: ${actual} záznamů, čekalo se ${expected}`);
  }
  for (const bucket of Object.keys(byBucket)) {
    if (!(bucket in EXPECTED_DISTRIBUTION)) problems.push(`koš ${bucket} není v předepsaném rozdělení`);
  }

  return problems;
}

export function computeFileHashes(dir = CORPUS_DIR) {
  const files = {};
  for (const rel of corpusRelativePaths(dir)) files[rel] = normalisedSha256(join(dir, rel));
  return files;
}

export function readManifest(dir = CORPUS_DIR) {
  return JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
}

/** Vrací pole vět popisujících nesouhlas manifestu se stromem. Prázdné pole = sedí. */
export function verifyAgainstManifest(dir = CORPUS_DIR) {
  const problems = [];
  const manifest = readManifest(dir);
  const actual = computeFileHashes(dir);

  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (!(rel in actual)) problems.push(`${rel}: v manifestu je, ve stromu chybí`);
    else if (actual[rel] !== hash) problems.push(`${rel}: hash nesouhlasí se zamčeným`);
  }
  for (const rel of Object.keys(actual)) {
    if (!(rel in manifest.files)) problems.push(`${rel}: ve stromu je, v manifestu chybí`);
  }
  return problems;
}

function buildManifest(previous, reason) {
  return {
    lockVersion: 1,
    corpusVersion: 'v3',
    algorithm: 'sha256',
    normalization:
      'CRLF -> LF před hashováním. Bez toho by hash téhož souboru závisel na tom, na jakém stroji se repo checkoutovalo.',
    coverageRule:
      'Manifest kryje KAŽDÝ soubor uvnitř evals/corpus-v3/ kromě sebe sama. Chybějící soubor je stejné selhání jako nesouhlasný hash.',
    frozenBefore: 'jediný výsledek nad tímhle korpusem. V okamžiku zápisu tohohle manifestu žádné neexistovaly.',
    writtenBy: 'P11 T3 (plans/P11-prekladac-svetu.md)',
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
  if (corpusProblems.length) fail('corpus-v3: korpus má vadný tvar, zamykat se nesmí', corpusProblems);

  if (verifyOnly) {
    if (!existsSync(manifestPath)) fail('corpus-v3: MANIFEST.lock neexistuje', ['sada ještě není zamčená']);
    const drift = verifyAgainstManifest();
    if (drift.length) fail('corpus-v3: strom se rozešel se zamčeným manifestem', drift);
    console.log(`corpus-v3: ${EXPECTED_TOTAL} vět, ${Object.keys(readManifest().files).length} souborů, zámek sedí`);
    return;
  }

  if (existsSync(manifestPath) && !refreeze) {
    fail('corpus-v3: zámek už existuje a přepsat se sám od sebe nesmí', [
      'ověření: node evals/corpus-v3/lock.mjs --verify',
      'přemrazení: node evals/corpus-v3/lock.mjs --refreeze --reason "<proč>"',
    ]);
  }
  if (refreeze && !(reason && reason.trim())) {
    fail('corpus-v3: --refreeze vyžaduje --reason', ['přemrazení bez zapsaného důvodu je tichý přepis']);
  }

  const previous = existsSync(manifestPath) ? readManifest() : undefined;
  const manifest = buildManifest(previous, refreeze ? reason : undefined);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`corpus-v3: zamčeno ${Object.keys(manifest.files).length} souborů, ${EXPECTED_TOTAL} vět`);
  for (const [rel, hash] of Object.entries(manifest.files)) console.log(`  ${hash.slice(0, 12)}  ${rel}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
