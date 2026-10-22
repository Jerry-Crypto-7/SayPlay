/**
 * Řetěz na dev sadě (P56C T7) → `dev-result.md`: každá ze 40 vět vynuceně jako řetěz (`buildChain` + `verifyChain`),
 * semínko jako publikace (`seedFrom` věty) a dvě další ze `derivedSeeds` pro odolnost. AC se počítá na prvním semínku.
 * Ladí se jen tady; zapečetěná sada (`holdout.json`) se neotvírá.
 *
 * T17 přidá cestu se čtením P56A: věty, které P56A přečetl modelem a čtení uložil (`evals/play/p56a/readings`),
 * stejně vynuceně jako řetěz – jednou se čtením, jednou slovníkem. Dev sadu P56C model nepřečetl.
 *
 * `npx vitest run --config vitest.measure.mts evals/play/p56c/dev.measure.ts`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '../../../src/app/api/play/_publish';
import { buildChain, VERB_MICROS } from '../../../src/play/chain/build';
import { CHAIN_MUTATORS } from '../../../src/play/chain/contract';
import { chainOrSingle } from '../../../src/play/chain/decide';
import { readForChain } from '../../../src/play/chain/read';
import { verifyChain } from '../../../src/play/chain/verify';
import { classifyGenre } from '../../../src/play/genre/classify';
import type { Reading } from '../../../src/play/read/schema';

interface DevSentence {
  readonly id: string;
  readonly family: string;
  readonly text: string;
}

const DIR = join(process.cwd(), 'evals/play/p56c');
const { sentences } = JSON.parse(readFileSync(join(DIR, 'dev.json'), 'utf8')) as { sentences: DevSentence[] };

/** Sady, které P56A přečetl modelem gpt-oss-20b (P56A T4); `family` = sada, věty bez platného čtení vypadnou. */
const READ_SETS = ['audit-12', 'p30-dev', 'p54c-dev'] as const;
const READ_MODEL = 'gpt-oss-20b';
const readSentences = READ_SETS.flatMap((name) =>
  (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p56a/readings', `${name}.${READ_MODEL}.json`), 'utf8')) as { readings: { id: string; text: string; reading: Reading | null }[] }).readings.flatMap(
    ({ id, text, reading }) => (reading === null ? [] : [{ sentence: { id: `${name}/${id}`, family: name, text }, reading }]),
  ),
);

interface Row {
  readonly id: string;
  readonly family: string;
  readonly seed: number;
  readonly keys: string;
  readonly failures: readonly string[];
  readonly controls: number;
  readonly lengthSec: number;
  readonly oneLook: boolean;
  readonly oneHero: boolean;
  /** `null` = věta nemá sloveso, které `VERB_MICROS` hraje. */
  readonly leadIsVerb: boolean | null;
  /** `null` = věta nemá protivníka. */
  readonly bossHasFoe: boolean | null;
  readonly ms: number;
  /** Kola 2 až N−1 s mutátorem a jejich počet (T16). */
  readonly twisted: number;
  readonly middle: number;
  /** Co by věta hrála bez vynucení (`chainOrSingle`, T8). */
  readonly decided: 'chain' | 'single';
}

function measure(sentence: DevSentence, seed: number, reading: Reading | null = null): Row {
  const start = performance.now();
  const read = readForChain(sentence.text, reading);
  const decided = chainOrSingle(sentence.text, read, classifyGenre(sentence.text, reading));
  const made = buildChain(sentence.text, read, seed);
  if (!made.ok) {
    return { id: sentence.id, family: sentence.family, seed, keys: '–', failures: made.issues, controls: 0, lengthSec: 0, oneLook: false, oneHero: false, leadIsVerb: null, bossHasFoe: null, ms: performance.now() - start, twisted: 0, middle: 0, decided };
  }
  const { rounds } = made.chain;
  const verdict = verifyChain(made.chain);
  const main = read.verbs[0]?.class;
  const named = main === undefined ? [] : VERB_MICROS[main];
  return {
    id: sentence.id,
    family: sentence.family,
    seed,
    keys: rounds.map((round) => (round.mutator === undefined ? round.key : `${round.key} + ${round.mutator}`)).join(' → '),
    failures: verdict.failures,
    controls: verdict.controls,
    lengthSec: verdict.lengthSec,
    oneLook: new Set(rounds.map((round) => round.spec.theme.look)).size === 1,
    oneHero: new Set(rounds.map((round) => round.spec.roles.find((role) => role.kind === 'player')?.label)).size === 1,
    leadIsVerb: named.length === 0 ? null : named.includes(rounds[0]!.key),
    bossHasFoe: read.foe === null ? null : rounds.at(-1)!.spec.roles.some((role) => role.label === read.foe),
    ms: performance.now() - start,
    twisted: rounds.filter((round) => round.mutator !== undefined).length,
    middle: rounds.length - 2,
    decided,
  };
}

const share = (rows: readonly Row[], test: (row: Row) => boolean): string => `${rows.filter(test).length}/${rows.length}`;
const applicable = (rows: readonly Row[], pick: (row: Row) => boolean | null): string => {
  const known = rows.filter((row) => pick(row) !== null);
  return `${known.filter((row) => pick(row) === true).length}/${known.length}`;
};

it('builds and verifies a chain for every dev sentence', () => {
  const primary = sentences.map((sentence) => measure(sentence, seedFrom(sentence.text)));
  const extra = sentences.flatMap((sentence) => derivedSeeds(seedFrom(sentence.text)).slice(1, 3).map((seed) => measure(sentence, seed)));
  const all = [...primary, ...extra];
  const lengths = primary.map((row) => row.lengthSec).sort((a, b) => a - b);
  const ms = all.map((row) => row.ms).sort((a, b) => a - b);
  const modelRows = readSentences.map(({ sentence, reading }) => measure(sentence, seedFrom(sentence.text), reading));
  const wordRows = readSentences.map(({ sentence }) => measure(sentence, seedFrom(sentence.text)));
  const both = (label: string, test: (row: Row) => boolean): string => `| ${label} | ${share(modelRows, test)} | ${share(wordRows, test)} |`;

  const lines = [
    `# P56C T7 / T16 / T17 – řetěz na dev sadě (${CHAIN_MUTATORS ? 's mutátory' : 'bez mutátorů'}, s P56A)`,
    '',
    `Změřeno ${new Date().toISOString().slice(0, 10)} \`dev.measure.ts\`: 40 vět vynuceně jako řetěz, čtení slovníkem (\`readForChain(text, null)\`), semínko \`seedFrom(věta)\` jako publikace; odolnost na dvou dalších semínkách z \`derivedSeeds\`.`,
    '',
    '| Kontrola | AC | Semínko publikace | + 2 semínka |',
    '|---|---|---|---|',
    `| \`verifyChain\` bez chyby | 40/40 | ${share(primary, (row) => row.failures.length === 0)} | ${share(all, (row) => row.failures.length === 0)} |`,
    `| ≥ 3 různá ovládání | ≥ 34/40 | ${share(primary, (row) => row.controls >= 3)} | ${share(all, (row) => row.controls >= 3)} |`,
    `| délka 30–90 s | 40/40 | ${share(primary, (row) => row.lengthSec >= 30 && row.lengthSec <= 90)} | ${share(all, (row) => row.lengthSec >= 30 && row.lengthSec <= 90)} |`,
    `| jeden \`theme.look\` ve všech kolech | 40/40 | ${share(primary, (row) => row.oneLook)} | ${share(all, (row) => row.oneLook)} |`,
    `| jeden popisek hrdiny ve všech kolech | 40/40 | ${share(primary, (row) => row.oneHero)} | ${share(all, (row) => row.oneHero)} |`,
    `| kolo 1 = hlavní sloveso (věty se slovesem z \`VERB_MICROS\`) | všechny | ${applicable(primary, (row) => row.leadIsVerb)} | ${applicable(all, (row) => row.leadIsVerb)} |`,
    `| boss nese protivníka věty (věty s protivníkem) | všechny | ${applicable(primary, (row) => row.bossHasFoe)} | ${applicable(all, (row) => row.bossHasFoe)} |`,
    '',
    `Délka řetězu (semínko publikace): min ${lengths[0]!.toFixed(1)} s, medián ${lengths[Math.floor(lengths.length / 2)]!.toFixed(1)} s, max ${lengths.at(-1)!.toFixed(1)} s. Stavba + ověření jednoho řetězu: medián ${Math.round(ms[Math.floor(ms.length / 2)]!)} ms, max ${Math.round(ms.at(-1)!)} ms (stroj není v klidu, orientační).`,
    '',
    `Mutátory (T16, \`CHAIN_MUTATORS\`): ${all.reduce((sum, row) => sum + row.twisted, 0)}/${all.reduce((sum, row) => sum + row.middle, 0)} kol 2 až N−1 nese mutátor (semínko publikace ${primary.reduce((sum, row) => sum + row.twisted, 0)}/${primary.reduce((sum, row) => sum + row.middle, 0)}); kolo bez něj = žádný mutátor z \`mutator-compat.json\` na rozložení kola neprošel robotem, nečinným nebo délkou.`,
    '',
    'Stavitel bere jen kola, která robot vyhraje a nečinný prohraje (až 4 semínka na kolo, pak jiná mikrohra), a řetěz pod 30 s doplní výměnou nejkratšího kola za delší – proto minimum délky leží těsně na prahu.',
    '',
    '## Se čtením P56A (T17)',
    '',
    `${modelRows.length} vět, které P56A přečetl modelem gpt-oss-20b (${READ_SETS.join(', ')}; uložená čtení v \`evals/play/p56a/readings\`, dev sadu P56C model nepřečetl), vynuceně jako řetěz, semínko publikace. Sloupec „slovník“ jsou tytéž věty bez čtení – cesta, když čtečka vyprší nebo selže.`,
    '',
    '| Kontrola | Čtení modelem | Slovník |',
    '|---|---|---|',
    both('`verifyChain` bez chyby', (row) => row.failures.length === 0),
    both('≥ 3 různá ovládání', (row) => row.controls >= 3),
    both('délka 30–90 s', (row) => row.lengthSec >= 30 && row.lengthSec <= 90),
    both('jeden popisek hrdiny ve všech kolech', (row) => row.oneHero),
    `| kolo 1 = hlavní sloveso (věty se slovesem z \`VERB_MICROS\`) | ${applicable(modelRows, (row) => row.leadIsVerb)} | ${applicable(wordRows, (row) => row.leadIsVerb)} |`,
    `| boss nese protivníka věty (věty s protivníkem) | ${applicable(modelRows, (row) => row.bossHasFoe)} | ${applicable(wordRows, (row) => row.bossHasFoe)} |`,
    ...READ_SETS.map((name) => {
      const chained = (rows: readonly Row[]) => share(rows.filter((row) => row.family === name), (row) => row.decided === 'chain');
      return `| věta by hrála řetěz (\`chainOrSingle\`), ${name} | ${chained(modelRows)} | ${chained(wordRows)} |`;
    }),
    '',
    ...(modelRows.some((row) => row.failures.length > 0)
      ? ['Chyby se čtením modelem:', '', ...modelRows.filter((row) => row.failures.length > 0).map((row) => `- ${row.id}: ${row.failures.join('; ')}`), '']
      : []),
    '## Věty (semínko publikace)',
    '',
    '| id | rodina | kola | ovládání | s | chyby |',
    '|---|---|---|---|---|---|',
    ...primary.map((row) => `| ${row.id} | ${row.family} | ${row.keys} | ${row.controls} | ${row.lengthSec.toFixed(1)} | ${row.failures.length === 0 ? '–' : row.failures.join('; ').replaceAll('|', '/')} |`),
    '',
    ...(extra.some((row) => row.failures.length > 0)
      ? ['## Chyby na dalších semínkách', '', ...extra.filter((row) => row.failures.length > 0).map((row) => `- ${row.id} (semínko ${row.seed}): ${row.failures.join('; ')}`), '']
      : []),
  ];
  writeFileSync(join(DIR, 'dev-result.md'), `${lines.join('\n')}\n`);

  expect(primary.filter((row) => row.failures.length > 0).map((row) => `${row.id}: ${row.failures.join('; ')}`)).toEqual([]);
}, 1_800_000);
