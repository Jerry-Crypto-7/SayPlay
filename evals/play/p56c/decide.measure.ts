/**
 * „Řetěz, nebo jedna hra“ na dev sadě (P56C T8) → `decide.md`: rozdělení po rodinách a větev pravidla u každé věty.
 * Práh `GENERIC_MARGIN` se ladí jen tady; zapečetěná sada se neotvírá.
 *
 * `npx vitest run --config vitest.measure.mts evals/play/p56c/decide.measure.ts`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { chainReasons, GENERIC_MARGIN } from '../../../src/play/chain/decide';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { readForChain } from '../../../src/play/chain/read';
import { classifyGenre, type GenreRanking } from '../../../src/play/genre/classify';
import type { Reading } from '../../../src/play/read/schema';

interface DevSentence {
  readonly id: string;
  readonly family: string;
  readonly text: string;
}

const DIR = join(process.cwd(), 'evals/play/p56c');
const { sentences } = JSON.parse(readFileSync(join(DIR, 'dev.json'), 'utf8')) as { sentences: DevSentence[] };

/** T17b: věty, které P56A přečetl modelem (uložená čtení, jako `dev.measure.ts`); dev sadu P56C model nepřečetl. */
const READ_SETS = ['audit-12', 'p30-dev', 'p54c-dev'] as const;
const READ_MODEL = 'gpt-oss-20b';
const readSentences = READ_SETS.flatMap((name) =>
  (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p56a/readings', `${name}.${READ_MODEL}.json`), 'utf8')) as { readings: { id: string; text: string; reading: Reading | null }[] }).readings.flatMap(
    ({ id, text, reading }) => (reading === null ? [] : [{ id: `${name}/${id}`, set: name, text, reading }]),
  ),
);

const topOf = (ranking: GenreRanking): string => {
  const [top, second] = ranking.ranked;
  return `${top!.genre}.${top!.mode} ${top!.score} (náskok ${top!.score - (second?.score ?? 0)})`;
};

it('splits the dev set into chains and single games', async () => {
  // Čtení může vybrat míč; `readForChain` staví návrh jedné hry a ten bez načtené fyziky spadne.
  await loadRapier();
  const rows = sentences.map((sentence) => {
    const ranking = classifyGenre(sentence.text, null);
    const [top, second] = ranking.ranked;
    return {
      ...sentence,
      reasons: chainReasons(sentence.text, readForChain(sentence.text, null), ranking),
      top: `${top!.genre}.${top!.mode} ${top!.score} (náskok ${top!.score - (second?.score ?? 0)})`,
    };
  });
  const chains = (families: readonly string[]): string => {
    const family = rows.filter((row) => families.includes(row.family));
    return `${family.filter((row) => row.reasons.length > 0).length}/${family.length}`;
  };
  const singles = rows.filter((row) => row.family === 'single_verb');

  const lines = [
    '# P56C T8 – řetěz, nebo jedna hra (dev)',
    '',
    `Změřeno ${new Date().toISOString().slice(0, 10)} \`decide.measure.ts\`, čtení slovníkem, \`classifyGenre(věta, null)\`. Práh náskoku obecné buňky \`GENERIC_MARGIN\` = ${GENERIC_MARGIN}: na dev leží mezi „a goth teenage ghost with a skateboard“ (\`runner.default\`, náskok 2 → řetěz) a „steer a hot air balloon…“, „catch snowflakes…“, „herd the runaway sheep…“ (obecná buňka, náskok 4 → jedna hra). Platí každá hodnota 3–4; zapečetěná sada ho potvrdí nebo vyvrátí.`,
    '',
    '| Rodina | AC | Výsledek |',
    '|---|---|---|',
    `| \`multi_verb\` → řetěz | ≥ 10/12 | ${chains(['multi_verb'])} |`,
    `| \`no_verb\` + \`world_only\` → řetěz | ≥ 15/18 | ${chains(['no_verb', 'world_only'])} |`,
    `| \`single_verb\` → jedna hra | ≥ 8/10 | ${singles.filter((row) => row.reasons.length === 0).length}/${singles.length} |`,
    '',
    '| id | rodina | rozhodnutí | větve | první buňka |',
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.id} | ${row.family} | ${row.reasons.length > 0 ? 'řetěz' : 'jedna hra'} | ${row.reasons.join(', ') || '–'} | ${row.top} |`),
    '',
  ];

  // T17b: tytéž větve se čtením modelem – čtení dává svému žánru +4 a staví ho první (`classifyGenre`).
  const readRows = readSentences.map(({ id, set, text, reading }) => {
    const ranking = classifyGenre(text, reading);
    const words = classifyGenre(text, null);
    return {
      id,
      set,
      text,
      genre: reading.genre === null ? '–' : `${reading.genre.genre}.${reading.genre.mode}`,
      verbs: reading.verbs.map((verb) => verb.class).join(' ') || '–',
      read: chainReasons(text, readForChain(text, reading), ranking),
      word: chainReasons(text, readForChain(text, null), words),
      top: topOf(ranking),
    };
  });
  const count = (list: readonly (typeof readRows)[number][], pick: (row: (typeof readRows)[number]) => readonly string[], reason?: string): string =>
    `${list.filter((row) => (reason === undefined ? pick(row).length > 0 : pick(row).includes(reason))).length}/${list.length}`;
  const differ = readRows.filter((row) => (row.read.length > 0) !== (row.word.length > 0));
  lines.push(
    '## Se čtením modelem (T17b)',
    '',
    `${readRows.length} vět, které P56A přečetl modelem ${READ_MODEL} (${READ_SETS.join(', ')}; uložená čtení v \`evals/play/p56a/readings\`). „slovník“ = tytéž věty bez čtení.`,
    '',
    '| sada | řetěz se čtením | řetěz slovníkem | `generic` se čtením | `generic` slovníkem | `multi_verb` se čtením | `multi_verb` slovníkem |',
    '|---|---|---|---|---|---|---|',
    ...[...READ_SETS, 'vše'].map((set) => {
      const list = set === 'vše' ? readRows : readRows.filter((row) => row.set === set);
      return `| ${set} | ${count(list, (row) => row.read)} | ${count(list, (row) => row.word)} | ${count(list, (row) => row.read, 'generic')} | ${count(list, (row) => row.word, 'generic')} | ${count(list, (row) => row.read, 'multi_verb')} | ${count(list, (row) => row.word, 'multi_verb')} |`;
    }),
    '',
    `**Rozhodnutí (T17b, 2026-10-22): práh \`GENERIC_MARGIN\` = ${GENERIC_MARGIN} zůstává i pro čtení.** Větev \`generic\` není u čtení vzácnější kvůli prahu – kde čtení přistane na obecné buňce, má náskok ≥ 7 jen u vět s jasným slovesem čtení (běžec „hedgehog rolls … avoiding foxes“); práh 7 (= 3 + bonus čtení 4) by přepnul jen a09 a x13, obě slovník už řetězem posílá. Rozdíl „řetěz se čtením / slovníkem“ dělá \`multi_verb\`: model u „chef catches eggs … while avoiding bombs“, „squash the bugs“, „tower defense against robots“ slyší jedno hlavní sloveso s vlastním žánrem – podle pravidla správně jedna hra; slovník z „avoid“ dělá druhé sloveso. Skutečná díra byla jinde: bonus čtení dělá z každé věty „slyšenou“, takže věta bez hratelného slovesa („purple elephants doing taxes“, „grandpa fixing his old car“ – sloveso \`idle\`, žánr \`quest\`) šla do jedné hry. Oprava v \`decide.ts\`: se čtením je věta neslyšená, když čtení nemá hratelné sloveso a první buňka není mikrohra řetězu – „wizard defends his tower“ (\`idle\`, ale \`defense.default\`) zůstane jednou hrou. Slovníková cesta se nemění.`,
    '',
    `Věty, kde čtení rozhodne jinak než slovník (${differ.length}):`,
    '',
    '| id | věta | se čtením | slovníkem | žánr čtení | slovesa čtení | první buňka se čtením |',
    '|---|---|---|---|---|---|---|',
    ...differ.map((row) => `| ${row.id} | ${row.text.replaceAll('|', '/').slice(0, 90)} | ${row.read.join(', ') || 'jedna hra'} | ${row.word.join(', ') || 'jedna hra'} | ${row.genre} | ${row.verbs} | ${row.top} |`),
    '',
  );
  writeFileSync(join(DIR, 'decide.md'), `${lines.join('\n')}\n`);
  expect(rows.length).toBe(40);
});
