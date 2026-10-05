/**
 * Baseline P37A (T2): návrh ze slov bez režiséra na `dev-150` a na vývojové
 * sadě P30 (`p30/dev.json`). Zapíše `baseline.json`, čte ho `baseline.md`.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p37a/baseline.measure.ts
 *
 * Dva zdroje:
 * - **offline na HEAD** – táž cesta jako hra z `/play` (`measureSentence`
 *   z `evals/play/p36/depth.ts`: žánr, robot vyhraje, nečinný prohraje) a řetěz
 *   věrnosti (`offlineChain`: hrdina a položky modelem, nebo kostkou);
 * - **živý klip** – verdikt soudce nad třemi snímky hry hrané robotem
 *   (`play-fidelity.mjs run --clip --draft-only` + `judge --clip`) z běhů
 *   `RUNS`; složky běhů jsou gitignorované, proto se verdikt přepíše sem.
 *
 * Položka, kterou řetěz kreslí a soudce ji v klipu nepoznal, je `not-recognized`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { offlineChain } from '../../../scripts/play-fidelity.mjs';
import { measureSentence } from '../p36/depth';

type Entry = { readonly item: string; readonly slot: 'hero' | 'role' | 'any' | 'setting' | 'verb' };
type Sentence = { readonly id: string; readonly text: string; readonly group?: string; readonly tags?: readonly string[]; readonly checklist: readonly Entry[] };
type Judged = { readonly judge?: { readonly draft?: Record<string, boolean> }; readonly judgeFrames?: { readonly draft?: number }; readonly draft: { readonly clip?: { readonly robot: boolean } } };

/** Běhy klipu (`evals/play/fidelity/runs/<id>`), z nichž baseline bere verdikty. */
export const RUNS = { p37a: 'p37a-t2-dev150', p30dev: 'p37a-t2-p30dev' } as const;
type SetName = keyof typeof RUNS;

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const sentencesOf = (relative: string) => (readJson(here(relative)) as { sentences: Sentence[] }).sentences;

const roleOf = (slot: Entry['slot']) => (slot === 'hero' ? 'hero' : slot === 'setting' ? 'setting' : slot === 'verb' ? 'verb' : 'item');

function clipOf(set: SetName, id: string): Judged | null {
  const path = here(`../fidelity/runs/${RUNS[set]}/${id}.json`);
  if (!existsSync(path)) return null;
  const result = readJson(path) as Judged;
  // Jen verdikt nad klipem; verdikt jednoho snímku sloveso neumí (losses #3, #7).
  return result.judgeFrames?.draft === 3 ? result : null;
}

function rowsOf(set: SetName, sentences: readonly Sentence[]) {
  const chain = new Map(offlineChain(sentences).sentences.map((row) => [row.id, row]));
  return sentences.map((sentence) => {
    const depth = measureSentence({ set: 'dev', id: sentence.id, text: sentence.text });
    const judged = clipOf(set, sentence.id);
    const seen = judged?.judge?.draft ?? null;
    const items = chain.get(sentence.id)!.items.map((item) => {
      const role = roleOf(item.slot as Entry['slot']);
      const recognized = seen === null ? null : seen[item.item] === true;
      // Sloveso nese ovládání, ne model: „ok“ v řetězu a nepoznané v klipu je ztráta obrazu.
      const why = item.why === 'ok' && recognized === false ? 'not-recognized' : item.why;
      return { item: item.item, role, drawn: item.drawn, recognized, why };
    });
    const heroes = items.filter((item) => item.role === 'hero');
    const things = items.filter((item) => item.role === 'item');
    const verb = items.find((item) => item.role === 'verb')!;
    return {
      set,
      id: sentence.id,
      text: sentence.text,
      group: set === 'p30dev' ? 'p30-dev' : (sentence.group as string),
      tags: sentence.tags ?? [],
      genre: depth.genre,
      playable: depth.playable,
      robotWins: depth.bot.end === 'won',
      idleLoses: depth.idle.end === 'lost',
      heroModel: heroes.length === 0 ? null : heroes.every((item) => item.drawn),
      itemModel: things.filter((item) => item.drawn).length,
      itemBox: things.filter((item) => item.why === 'no-model').length,
      itemOf: things.length,
      verbRecognized: verb.recognized,
      robotInClip: judged?.draft.clip?.robot ?? null,
      items,
    };
  });
}

type Row = ReturnType<typeof rowsOf>[number];

const share = (hit: number, of: number) => ({ hit, of, share: of === 0 ? null : Math.round((hit / of) * 1000) / 1000 });

function summary(rows: readonly Row[]) {
  const judged = rows.filter((row) => row.verbRecognized !== null);
  const withHero = rows.filter((row) => row.heroModel !== null);
  const genres: Record<string, number> = {};
  for (const row of rows) genres[row.genre] = (genres[row.genre] ?? 0) + 1;
  const itemOf = rows.reduce((sum, row) => sum + row.itemOf, 0);
  return {
    sentences: rows.length,
    verbRecognized: share(judged.filter((row) => row.verbRecognized).length, judged.length),
    robotInClip: share(judged.filter((row) => row.robotInClip === true).length, judged.length),
    heroModel: share(withHero.filter((row) => row.heroModel).length, withHero.length),
    itemModel: share(rows.reduce((sum, row) => sum + row.itemModel, 0), itemOf),
    itemBox: share(rows.reduce((sum, row) => sum + row.itemBox, 0), itemOf),
    playable: share(rows.filter((row) => row.playable).length, rows.length),
    robotWins: share(rows.filter((row) => row.robotWins).length, rows.length),
    idleLoses: share(rows.filter((row) => row.idleLoses).length, rows.length),
    genres: Object.fromEntries(Object.entries(genres).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

/** Skupiny ztrát `why × role × žánr` podle počtu postižených vět (vzor `p30b/losses.md`). */
function lossGroups(rows: readonly Row[]) {
  const groups = new Map<string, { why: string; role: string; genre: string; ids: Set<string>; items: string[] }>();
  for (const row of rows) {
    for (const item of row.items) {
      if (item.why === 'ok') continue;
      const key = `${item.why}|${item.role}|${row.genre}`;
      const group = groups.get(key) ?? { why: item.why, role: item.role, genre: row.genre, ids: new Set<string>(), items: [] };
      group.ids.add(`${row.set}:${row.id}`);
      group.items.push(`${row.id}:${item.item}`);
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, why: group.why, role: group.role, genre: group.genre, sentences: group.ids.size, items: group.items }))
    .sort((a, b) => b.sentences - a.sentences || a.key.localeCompare(b.key));
}

it('writes evals/play/p37a/baseline.json', async () => {
  await loadRapier();
  const rows = [...rowsOf('p37a', sentencesOf('./dev-150.json')), ...rowsOf('p30dev', sentencesOf('../p30/dev.json'))];
  const groups = ['unknown-verb', 'non-game', 'fantasy', 'mix', 'p30-dev'];
  const report = {
    about: 'P37A T2 baseline: the word draft without the director on dev-150 and the P30 dev set. Offline at HEAD plus the clip judge of the runs in `runs`. See baseline.md.',
    runs: RUNS,
    summary: {
      all: summary(rows),
      p37a: summary(rows.filter((row) => row.set === 'p37a')),
      ...Object.fromEntries(groups.map((group) => [group, summary(rows.filter((row) => row.group === group))])),
    },
    losses: lossGroups(rows),
    rows,
  };
  writeFileSync(here('./baseline.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const [name, part] of Object.entries(report.summary)) {
    console.log(`${name}: n ${part.sentences}, verb ${JSON.stringify(part.verbRecognized)}, hero ${part.heroModel.share}, items model ${part.itemModel.share} box ${part.itemBox.share}, robot ${part.robotWins.share}, idle loses ${part.idleLoses.share}, genres ${JSON.stringify(part.genres)}`);
  }
  for (const group of report.losses.slice(0, 12)) console.log(`${group.sentences}× ${group.key}: ${group.items.slice(0, 8).join(', ')}`);
}, 30 * 60_000);
