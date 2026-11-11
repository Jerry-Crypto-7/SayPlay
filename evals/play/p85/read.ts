/**
 * P85A T1: jak rychlá verze přečte 20 vět poroty – stejnou cestou jako `/api/play/games` bez čtečky modelem
 * (řetěz nebo jedna hra, `draftGameSpecWithMeta`, přiznání na pruhu). Vypíše řádek JSON na větu; s cestou souboru
 * zapíše `id<TAB>hrdina<TAB>soupeř<TAB>typ<TAB>cíl<TAB>pruh` pro porovnání před a po opravě.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p85/read.ts [out.tsv] [set.json]
 *
 * Druhý argument: jiná sada ve tvaru `{ sentences: [{ id, text }] }` (sada 200 vět `evals/play/p30/test-200.json`).
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { readFacts } from '@/components/play/lab';
import { loadRapier } from '@/play/arcade/physics/world';
import { chainOrSingle } from '@/play/chain/decide';
import { readForChain } from '@/play/chain/read';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { classifyGenre } from '@/play/genre/classify';

export interface Reading {
  readonly id: string;
  readonly text: string;
  readonly chain: boolean;
  readonly genre: string;
  readonly game: string;
  readonly you: string | null;
  readonly against: readonly string[];
  readonly place: string;
  readonly goal: string;
  readonly strip: string | null;
}

export async function readSentence(id: string, text: string): Promise<Reading> {
  const chain = chainOrSingle(text, readForChain(text, null), classifyGenre(text, null)) === 'chain';
  const { spec } = draftGameSpecWithMeta(text, 1);
  const facts = readFacts(spec, 'draft', text);
  const honesty = await honestyForSpec(text, spec, 1);
  return {
    id,
    text,
    chain,
    genre: spec.genre?.id ?? spec.archetype,
    game: facts.game,
    you: facts.you,
    against: facts.against,
    place: facts.place,
    goal: spec.tutorial.goalLine,
    strip: honesty?.reason ?? null,
  };
}

if (process.argv[1]?.endsWith('read.ts')) {
  await loadRapier();
  const setPath = process.argv[3] ?? 'evals/play/p85/prompts.json';
  const { sentences } = JSON.parse(readFileSync(setPath, 'utf8')) as { sentences: { id: string; text: string }[] };
  const rows: Reading[] = [];
  for (const { id, text } of sentences) rows.push(await readSentence(id, text));
  if (process.argv[3] === undefined) for (const row of rows) console.log(JSON.stringify(row));
  const out = process.argv[2];
  if (out !== undefined) {
    const line = (row: Reading): string => [row.id, row.you ?? '-', row.against.join('|') || '-', `${row.chain ? 'chain:' : ''}${row.genre}`, row.goal, row.strip ?? '-'].join('\t');
    writeFileSync(out, rows.map(line).join('\n') + '\n');
  }
}
