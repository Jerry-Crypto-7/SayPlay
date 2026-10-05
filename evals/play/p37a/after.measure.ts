/**
 * P37A T10: návrh ze slov po rodinách sloves (T3–T6) proti baseline T2 na
 * `dev-150` a na vývojové sadě P30 (`p30/dev.json`). Zapíše `after.json`, čte
 * ho `after.md`. `baseline.json` nepřepisuje.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p37a/after.measure.ts
 *
 * - **po** – táž měřidla jako `baseline.measure.ts` na HEAD: offline
 *   `measureSentence` (žánr, robot vyhraje, nečinný prohraje) a `offlineChain`
 *   (hrdina a položky modelem, nebo kostkou), klip z běhů `AFTER`.
 * - **před** – offline sloupce z commitnuté `baseline.json` (měřeno na
 *   `ea31005f`); verdikt klipu z běhů `BEFORE` (tytéž klipy T2), které T10
 *   přesoudila slepým soudcem (`b4475a4f`). Neslepé číslo T2 zůstává
 *   v `baseline.json` a nese ho `before.notBlind`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { offlineChain } from '../../../scripts/play-fidelity.mjs';
import { measureSentence } from '../p36/depth';

type Slot = 'hero' | 'role' | 'any' | 'setting' | 'verb';
type Entry = { readonly item: string; readonly slot: Slot };
type Sentence = { readonly id: string; readonly text: string; readonly group?: string; readonly tags?: readonly string[]; readonly checklist: readonly Entry[] };
type Judged = {
  readonly judge?: { readonly draft?: Record<string, boolean> };
  readonly judgeFrames?: { readonly draft?: number };
  readonly draft: { readonly clip?: { readonly robot: boolean }; readonly spec?: { readonly heroAction?: string } };
};
type Item = { readonly item: string; readonly role: string; readonly drawn: boolean; readonly recognized: boolean | null; readonly why: string };
type Row = {
  readonly set: SetName;
  readonly id: string;
  readonly text: string;
  readonly group: string;
  readonly tags: readonly string[];
  readonly genre: string;
  readonly heroAction?: string | null;
  readonly playable: boolean;
  readonly robotWins: boolean;
  readonly idleLoses: boolean;
  readonly heroModel: boolean | null;
  readonly itemModel: number;
  readonly itemBox: number;
  readonly itemOf: number;
  readonly verbRecognized: boolean | null;
  readonly robotInClip: boolean | null;
  readonly items: readonly Item[];
};

/** Běhy klipu (`evals/play/fidelity/runs/<id>`): po = T10 na HEAD, před = klipy T2 přesouzené slepě. */
export const AFTER = { p37a: 'p37a-t10-dev150', p30dev: 'p37a-t10-p30dev' } as const;
export const BEFORE = { p37a: 'p37a-t2-dev150', p30dev: 'p37a-t2-p30dev' } as const;
type SetName = keyof typeof AFTER;
type Runs = typeof AFTER | typeof BEFORE;

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const sentencesOf = (relative: string) => (readJson(here(relative)) as { sentences: Sentence[] }).sentences;

const roleOf = (slot: Slot) => (slot === 'hero' ? 'hero' : slot === 'setting' ? 'setting' : slot === 'verb' ? 'verb' : 'item');

function clipOf(runs: Runs, set: SetName, id: string): Judged | null {
  const path = here(`../fidelity/runs/${runs[set]}/${id}.json`);
  if (!existsSync(path)) return null;
  const result = readJson(path) as Judged;
  // Jen verdikt nad klipem; verdikt jednoho snímku sloveso neumí (losses #3, #7).
  return result.judgeFrames?.draft === 3 ? result : null;
}

/** Řádky „po“: táž cesta jako `baseline.measure.ts`, klip z `AFTER`. */
function afterRows(set: SetName, sentences: readonly Sentence[]): Row[] {
  const chain = new Map(offlineChain(sentences).sentences.map((row) => [row.id, row]));
  return sentences.map((sentence) => {
    const depth = measureSentence({ set: 'dev', id: sentence.id, text: sentence.text });
    const judged = clipOf(AFTER, set, sentence.id);
    const seen = judged?.judge?.draft ?? null;
    const items = chain.get(sentence.id)!.items.map((item) => {
      const role = roleOf(item.slot as Slot);
      const recognized = seen === null ? null : seen[item.item] === true;
      // Sloveso nese ovládání, ne model: „ok“ v řetězu a nepoznané v klipu je ztráta obrazu.
      const why = item.why === 'ok' && recognized === false ? 'not-recognized' : item.why;
      return { item: item.item, role, drawn: item.drawn, recognized, why };
    });
    return rowOf({
      set,
      id: sentence.id,
      text: sentence.text,
      group: set === 'p30dev' ? 'p30-dev' : (sentence.group as string),
      tags: sentence.tags ?? [],
      genre: depth.genre,
      heroAction: judged?.draft.spec?.heroAction ?? null,
      playable: depth.playable,
      robotWins: depth.bot.end === 'won',
      idleLoses: depth.idle.end === 'lost',
      robotInClip: judged?.draft.clip?.robot ?? null,
      items,
    });
  });
}

/** Řádky „před“: offline část z `baseline.json`, verdikt klipu ze slepého přesouzení běhů `BEFORE`. */
function beforeRows(baseline: readonly Row[]): Row[] {
  return baseline.map((row) => {
    const judged = clipOf(BEFORE, row.set, row.id);
    const seen = judged?.judge?.draft ?? null;
    const items = row.items.map((item) => {
      // `not-recognized` v baseline.json je „ok“ řetězu, které neslepý soudce nepoznal.
      const chainWhy = item.why === 'not-recognized' ? 'ok' : item.why;
      const recognized = seen === null ? null : seen[item.item] === true;
      return { ...item, recognized, why: chainWhy === 'ok' && recognized === false ? 'not-recognized' : chainWhy };
    });
    return rowOf({ ...row, robotInClip: judged?.draft.clip?.robot ?? null, items });
  });
}

function rowOf(row: Omit<Row, 'heroModel' | 'itemModel' | 'itemBox' | 'itemOf' | 'verbRecognized'>): Row {
  const heroes = row.items.filter((item) => item.role === 'hero');
  const things = row.items.filter((item) => item.role === 'item');
  const verb = row.items.find((item) => item.role === 'verb')!;
  return {
    ...row,
    heroModel: heroes.length === 0 ? null : heroes.every((item) => item.drawn),
    itemModel: things.filter((item) => item.drawn).length,
    itemBox: things.filter((item) => item.why === 'no-model').length,
    itemOf: things.length,
    verbRecognized: verb.recognized,
  };
}

const share = (hit: number, of: number) => ({ hit, of, share: of === 0 ? null : Math.round((hit / of) * 1000) / 1000 });

function summary(rows: readonly Row[]) {
  const judged = rows.filter((row) => row.verbRecognized !== null);
  const withHero = rows.filter((row) => row.heroModel !== null);
  const heroJudged = withHero.filter((row) => row.items.some((item) => item.role === 'hero' && item.recognized !== null));
  const genres: Record<string, number> = {};
  for (const row of rows) genres[row.genre] = (genres[row.genre] ?? 0) + 1;
  const itemOf = rows.reduce((sum, row) => sum + row.itemOf, 0);
  return {
    sentences: rows.length,
    verbRecognized: share(judged.filter((row) => row.verbRecognized).length, judged.length),
    robotInClip: share(judged.filter((row) => row.robotInClip === true).length, judged.length),
    heroModel: share(withHero.filter((row) => row.heroModel).length, withHero.length),
    // Navíc proti T2: hrdina poznaný slepým soudcem v klipu (všichni hrdinové věty).
    heroRecognized: share(heroJudged.filter((row) => row.items.filter((item) => item.role === 'hero').every((item) => item.recognized)).length, heroJudged.length),
    itemModel: share(rows.reduce((sum, row) => sum + row.itemModel, 0), itemOf),
    itemBox: share(rows.reduce((sum, row) => sum + row.itemBox, 0), itemOf),
    // Navíc proti T2: co rodiny změnily ve specu, i když to klip neukáže – položka věty ve specu, sloveso čtené ovládáním.
    itemInSpec: share(rows.reduce((sum, row) => sum + row.items.filter((item) => item.role === 'item' && item.why !== 'not-in-spec').length, 0), itemOf),
    verbRead: share(rows.filter((row) => ['ok', 'not-recognized'].includes(row.items.find((item) => item.role === 'verb')!.why)).length, rows.length),
    playable: share(rows.filter((row) => row.playable).length, rows.length),
    robotWins: share(rows.filter((row) => row.robotWins).length, rows.length),
    idleLoses: share(rows.filter((row) => row.idleLoses).length, rows.length),
    genres: Object.fromEntries(Object.entries(genres).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

/** Sloveso poznané v klipu podle klíče (žánr, `heroAction`), seřazeno podle počtu vět. */
function verbBy(rows: readonly Row[], keyOf: (row: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const row of rows.filter((row) => row.verbRecognized !== null)) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([key, part]) => [key, { ...share(part.filter((row) => row.verbRecognized).length, part.length), ids: part.filter((row) => row.verbRecognized).map((row) => row.id) }]),
  );
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

const GROUPS = ['unknown-verb', 'non-game', 'fantasy', 'mix', 'p30-dev'];

function summaries(rows: readonly Row[]) {
  return {
    all: summary(rows),
    p37a: summary(rows.filter((row) => row.set === 'p37a')),
    ...Object.fromEntries(GROUPS.map((group) => [group, summary(rows.filter((row) => row.group === group))])),
  };
}

it('writes evals/play/p37a/after.json', async () => {
  await loadRapier();
  const baseline = readJson(here('./baseline.json')) as { summary: Record<string, ReturnType<typeof summary>>; rows: Row[] };
  const before = beforeRows(baseline.rows);
  const after = [...afterRows('p37a', sentencesOf('./dev-150.json')), ...afterRows('p30dev', sentencesOf('../p30/dev.json'))];
  const report = {
    about: 'P37A T10: the word draft without the director after the verb families (T3–T6) against the T2 baseline, on dev-150 and the P30 dev set. Before = offline numbers of baseline.json + the T2 clips re-judged by the blind judge; after = HEAD offline + the clip judge of the runs in `runs.after`. See after.md.',
    runs: { before: BEFORE, after: AFTER },
    before: {
      summary: summaries(before),
      // Verdikt T2 soudce, který viděl spec ve `cwd` (před `b4475a4f`).
      notBlind: Object.fromEntries(Object.entries(baseline.summary).map(([name, part]) => [name, part.verbRecognized])),
    },
    after: {
      summary: summaries(after),
      verbByGenre: verbBy(after.filter((row) => row.set === 'p37a'), (row) => row.genre),
      verbByHeroAction: verbBy(after.filter((row) => row.set === 'p37a'), (row) => row.heroAction ?? 'none'),
    },
    losses: { before: lossGroups(before), after: lossGroups(after) },
    rows: { before, after },
  };
  writeFileSync(here('./after.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const [phase, part] of [['before', report.before.summary], ['after', report.after.summary]] as const) {
    for (const [name, value] of Object.entries(part)) {
      console.log(`${phase} ${name}: n ${value.sentences}, verb ${JSON.stringify(value.verbRecognized)}, hero ${value.heroModel.share} (clip ${value.heroRecognized.share}), items model ${value.itemModel.share} box ${value.itemBox.share}, robot ${value.robotWins.share}, idle loses ${value.idleLoses.share}`);
    }
  }
  console.log(`after genres dev-150: ${JSON.stringify(report.after.summary.p37a.genres)}`);
  console.log(`after verb by genre: ${JSON.stringify(Object.fromEntries(Object.entries(report.after.verbByGenre).map(([key, value]) => [key, `${value.hit}/${value.of}`])))}`);
  console.log(`after verb by heroAction: ${JSON.stringify(Object.fromEntries(Object.entries(report.after.verbByHeroAction).map(([key, value]) => [key, `${value.hit}/${value.of}`])))}`);
  for (const group of report.losses.after.slice(0, 12)) console.log(`after ${group.sentences}× ${group.key}: ${group.items.slice(0, 8).join(', ')}`);
}, 30 * 60_000);
