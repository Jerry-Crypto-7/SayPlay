/**
 * P70A T2: kolik vět pošle rychlá cesta do řetězu mikroher (`chainOrSingle` nad čtením slovníkem a
 * `classifyGenre(věta, null)` – jako `POST /api/play/games`, kde rychlá hra na čtečku nečeká). Sady: zapečetěná
 * sada 200 (`p30/test-200.json`) a obecné věty P68R a P68T (`half: "general"`). U každé věty i to, jestli
 * výslovně žádá o víc her (`CHAIN_CUES`) – řetěz bez znaku je chyba, kterou T2 odstraňuje.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p70a/chains.ts \
 *     --out chains-before --commit <sha>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAIN_CUES, chainOrSingle, chainReasons } from '@/play/chain/decide';
import { readForChain } from '@/play/chain/read';
import { classifyGenre } from '@/play/genre/classify';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

export const SETS = {
  test200: { path: 'evals/play/p30/test-200.json', general: false },
  p68r: { path: 'evals/play/p68r/holdout.json', general: true },
  p68t: { path: 'evals/play/p68t/holdout.json', general: true },
} as const;
export type SetId = keyof typeof SETS;

export interface ChainRow {
  readonly set: SetId;
  readonly id: string;
  readonly text: string;
  readonly chain: boolean;
  readonly cue: boolean;
  readonly reasons: readonly string[];
}

export interface SetShare {
  readonly sentences: number;
  readonly chains: number;
  readonly share: number;
  /** Řetězy u vět bez znaku – cíl T2 je 0. */
  readonly withoutCue: number;
}

export function sentencesOf(set: SetId): { id: string; text: string }[] {
  const doc = JSON.parse(readFileSync(join(ROOT, SETS[set].path), 'utf8')) as { sentences: { id: string; text: string; half?: string }[] };
  return doc.sentences.filter((row) => !SETS[set].general || row.half === 'general').map(({ id, text }) => ({ id, text }));
}

export function shareOf(rows: readonly ChainRow[]): SetShare {
  const chains = rows.filter((row) => row.chain);
  return { sentences: rows.length, chains: chains.length, share: rows.length === 0 ? 0 : Math.round((chains.length / rows.length) * 1000) / 1000, withoutCue: chains.filter((row) => !row.cue).length };
}

export function measureChains(): ChainRow[] {
  return (Object.keys(SETS) as SetId[]).flatMap((set) => sentencesOf(set).map(({ id, text }) => {
    const read = readForChain(text, null);
    const ranking = classifyGenre(text, null);
    return { set, id, text, chain: chainOrSingle(text, read, ranking) === 'chain', cue: CHAIN_CUES.test(text.toLowerCase()), reasons: chainReasons(text, read, ranking) };
  }));
}

function main(): void {
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const out = flag('--out') ?? 'chains';
  const rows = measureChains();
  const shares = Object.fromEntries((Object.keys(SETS) as SetId[]).map((set) => [set, shareOf(rows.filter((row) => row.set === set))]));
  const doc = { schema: 'p70a-chains.v1', commit: flag('--commit') ?? null, measuredAt: new Date().toISOString(), about: 'chainOrSingle(sentence, readForChain(sentence, null), classifyGenre(sentence, null)) per sentence, as the quick path of POST /api/play/games; cue = CHAIN_CUES (asks for several games).', shares, all: shareOf(rows), rows };
  writeFileSync(join(HERE, `${out}.json`), `${JSON.stringify(doc, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ shares, all: doc.all }, null, 1)}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
