/**
 * P78 T3: kontrola „sloveso přečteno“ po rozšíření o novější hry, nad stejnou held-out sadou 200 vět jako P74 T5.
 * Zapíše `verb.json`: staré číslo z `../p74/run-2026-11-07.json`, nové z `offlineChain` (stejné měřidlo, rychlá
 * verze, offline) a seznam vět, které se změnily. Nic se podle sady neladí – mění se jen kontrola.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p78/verb.measure.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { offlineChain } from '../../../scripts/play-fidelity.mjs';

type Slot = 'hero' | 'role' | 'any' | 'setting' | 'verb';
type Sentence = { readonly id: string; readonly text: string; readonly checklist: readonly { readonly item: string; readonly slot: Slot }[] };
type OldRow = { readonly id: string; readonly genre: string; readonly verbRead: boolean };

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(here(path), 'utf8')) as T;

it('writes evals/play/p78/verb.json', async () => {
  await loadRapier();
  const sentences = readJson<{ sentences: Sentence[] }>('../p30/test-200.json').sentences;
  const old = new Map(readJson<{ rows: OldRow[] }>('../p74/run-2026-11-07.json').rows.map((row) => [row.id, row]));
  const chain = offlineChain(sentences).sentences;
  const rows = chain.map((row) => {
    const verb = row.items.find((item) => item.slot === 'verb');
    const sentence = sentences.find((candidate) => candidate.id === row.id)!;
    return { id: row.id, text: sentence.text, verb: sentence.checklist.find((entry) => entry.slot === 'verb')?.item ?? null, genre: old.get(row.id)?.genre ?? row.genre, before: old.get(row.id)?.verbRead ?? false, after: verb?.why === 'ok' };
  });
  const changed = rows.filter((row) => row.before !== row.after);
  const report = {
    about: 'P78 T3: verb-read check on the held-out test-200 set, offline quick version, before and after the check learned the newer game types (native glide, walker and ball generators; games that carry their genre in spec.genre). Same meter as P74 T5 (offlineChain); nothing tuned on the set.',
    measuredOn: '2026-11-08',
    set: 'evals/play/p30/test-200.json',
    before: { file: 'evals/play/p74/run-2026-11-07.json', hit: rows.filter((row) => row.before).length, of: rows.length },
    after: { hit: rows.filter((row) => row.after).length, of: rows.length },
    changed,
  };
  // `VERB_OUT`: běh se starou kontrolou nad dnešním stromem jde do jiného souboru (odliší změnu kontroly od změn hry od 7. 11.).
  writeFileSync(process.env.VERB_OUT ?? here('./verb.json'), `${JSON.stringify(report, null, 1)}\n`);
}, 30 * 60_000);
