/**
 * Kolo 1 řetězu (P56C T19) → `round1.md`: kterou mikrohrou řetěz začíná na sadě řetězu (`chain-sentences.json`),
 * na celé dev sadě vynuceně jako řetěz a se čtením P56A (`evals/play/p56a/readings`), plus dvě věty z emulace telefonu.
 * Semínko jako publikace (`seedFrom` věty). `ROUND1_LABEL=before|after` – sloupec, do kterého se běh zapíše.
 *
 * `ROUND1_LABEL=after npx vitest run --config vitest.measure.mts evals/play/p56c/round1.measure.ts`
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '../../../src/app/api/play/_publish';
import { buildChain } from '../../../src/play/chain/build';
import { readForChain } from '../../../src/play/chain/read';
import { verifyChain } from '../../../src/play/chain/verify';
import type { Reading } from '../../../src/play/read/schema';

interface Sentence {
  readonly id: string;
  readonly text: string;
}

const DIR = join(process.cwd(), 'evals/play/p56c');
const sentencesOf = (file: string): Sentence[] => (JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { sentences: Sentence[] }).sentences;
const READ_SETS = ['audit-12', 'p30-dev', 'p54c-dev'] as const;
const READ_MODEL = 'gpt-oss-20b';
const readings = READ_SETS.flatMap((name) =>
  (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p56a/readings', `${name}.${READ_MODEL}.json`), 'utf8')) as { readings: { id: string; text: string; reading: Reading | null }[] }).readings.flatMap(
    ({ id, text, reading }) => (reading === null ? [] : [{ id: `${name}/${id}`, text, reading }]),
  ),
);
/** Věty z emulace telefonu 22. 10. (server bez klíčů modelu = čtení slovníkem). */
const PHONE: readonly Sentence[] = [
  { id: 'hedgehog', text: 'a hedgehog paramedic rolls through traffic, rescues hurt pigeons and races to the vet' },
  { id: 'lighthouse', text: 'a foggy lighthouse cliff at midnight' },
];

interface Row {
  readonly id: string;
  readonly first: string;
  readonly keys: string;
  readonly verified: boolean;
}

function row({ id, text }: Sentence, reading: Reading | null = null, seed = seedFrom(text.trim())): Row {
  const made = buildChain(text, readForChain(text, reading), seed);
  if (!made.ok) return { id, first: '–', keys: made.issues.join('; '), verified: false };
  return { id, first: made.chain.rounds[0]!.key, keys: made.chain.rounds.map((round) => round.key).join(' → '), verified: verifyChain(made.chain).failures.length === 0 };
}

function spread(rows: readonly Row[]): { readonly top: string; readonly topShare: number; readonly counts: Record<string, number>; readonly verified: string } {
  const counts: Record<string, number> = {};
  for (const { first } of rows) counts[first] = (counts[first] ?? 0) + 1;
  const [top, count] = Object.entries(counts).sort((p, q) => q[1] - p[1])[0]!;
  return { top, topShare: count / rows.length, counts, verified: `${rows.filter((r) => r.verified).length}/${rows.length}` };
}

it('rozložení kola 1 řetězu', () => {
  const label = process.env.ROUND1_LABEL ?? 'after';
  const sets = {
    chain: sentencesOf('chain-sentences.json').map((sentence) => row(sentence)),
    // Kolo 1 se od T19 losuje semínkem: odhad rozložení přes všechna čtyři semínka, která publikace věty zkouší.
    chain4: sentencesOf('chain-sentences.json').flatMap((sentence) => derivedSeeds(seedFrom(sentence.text.trim())).map((seed) => row(sentence, null, seed))),
    dev: sentencesOf('dev.json').map((sentence) => row(sentence)),
    read: readings.map(({ id, text, reading }) => row({ id, text }, reading)),
    phone: PHONE.map((sentence) => row(sentence)),
  };
  const file = join(DIR, 'round1.json');
  const all = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, Record<string, Row[]>>;
  all[label] = sets;
  writeFileSync(file, `${JSON.stringify(all, null, 1)}\n`);

  const labels = Object.keys(all);
  const lines = ['# P56C T19 – kolo 1 řetězu', '', 'Generuje `round1.measure.ts` (popis v hlavičce). Podíl = nejčastější první mikrohra / řetězy sady.', ''];
  lines.push(`| Sada | ${labels.map((name) => `${name}: nejčastější kolo 1`).join(' | ')} | ${labels.map((name) => `${name}: verifyChain`).join(' | ')} |`, `|---|${labels.map(() => '---|').join('')}${labels.map(() => '---|').join('')}`);
  const SETS = ['chain', 'chain4', 'dev', 'read'] as const;
  for (const set of SETS) {
    const cells = labels.map((name) => (all[name]![set] === undefined ? null : spread(all[name]![set]!)));
    lines.push(`| ${set} (${sets[set].length}) | ${cells.map((cell) => (cell === null ? '–' : `${cell.top} ${Math.round(cell.topShare * 100)} %`)).join(' | ')} | ${cells.map((cell) => cell?.verified ?? '–').join(' | ')} |`);
  }
  for (const name of labels) {
    lines.push('', `## ${name}`, '');
    for (const set of SETS) if (all[name]![set] !== undefined) lines.push(`- ${set}: ${Object.entries(spread(all[name]![set]!).counts).sort((p, q) => q[1] - p[1]).map(([key, count]) => `${key} ${count}`).join(', ')}`);
    for (const phone of all[name]!.phone!) lines.push(`- telefon ${phone.id}: ${phone.keys}`);
  }
  writeFileSync(join(DIR, 'round1.md'), `${lines.join('\n')}\n`);
  expect(sets.chain.length).toBeGreaterThan(0);
}, 1_800_000);
