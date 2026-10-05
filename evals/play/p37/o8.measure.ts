/**
 * P37 O8: návrh ze slov bez režiséra nad sloučeným P37 A+B+C+D (`6c3e6376`)
 * na vývojových sadách proti P37A T10 a jedno otevření zapečetěné sady
 * `p30/test-200.json`. Zapíše `o8.json`, čte ho `o8.md`. `../p37a/after.json`
 * jen čte.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p37/o8.measure.ts
 *
 * Táž měřidla jako `../p37a/after.measure.ts`: offline `measureSentence`
 * (žánr, robot vyhraje, nečinný prohraje) a `offlineChain` (hrdina a položky
 * modelem, nebo kostkou), klip z běhů `RUNS` přesouzený slepým soudcem.
 * Zapečetěná sada se tu čte jen kvůli tomuto jedinému souhrnu jejího běhu
 * (`test-opened.json` → `p37-o8-test200`); nic se podle ní neladí.
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
  readonly group: string;
  readonly tags: readonly string[];
  readonly genre: string;
  readonly heroAction: string | null;
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

/** Běhy klipu (`evals/play/fidelity/runs/<id>`, mimo git). */
export const RUNS = { p37a: 'p37-o8-dev', p30dev: 'p37-o8-p30dev', test: 'p37-o8-test200' } as const;
type SetName = keyof typeof RUNS;

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const sentencesOf = (relative: string) => (readJson(here(relative)) as { sentences: Sentence[] }).sentences;

const roleOf = (slot: Slot) => (slot === 'hero' ? 'hero' : slot === 'setting' ? 'setting' : slot === 'verb' ? 'verb' : 'item');

function clipOf(set: SetName, id: string): Judged | null {
  const path = here(`../fidelity/runs/${RUNS[set]}/${id}.json`);
  if (!existsSync(path)) return null;
  const result = readJson(path) as Judged;
  // Jen verdikt nad klipem; verdikt jednoho snímku sloveso neumí.
  return result.judgeFrames?.draft === 3 ? result : null;
}

function rowsOf(set: SetName, sentences: readonly Sentence[]): Row[] {
  const chain = new Map(offlineChain(sentences).sentences.map((row) => [row.id, row]));
  return sentences.map((sentence) => {
    const depth = measureSentence({ set: 'dev', id: sentence.id, text: sentence.text });
    const judged = clipOf(set, sentence.id);
    const seen = judged?.judge?.draft ?? null;
    const items = chain.get(sentence.id)!.items.map((item) => {
      const role = roleOf(item.slot as Slot);
      const recognized = seen === null ? null : seen[item.item] === true;
      const why = item.why === 'ok' && recognized === false ? 'not-recognized' : item.why;
      return { item: item.item, role, drawn: item.drawn, recognized, why };
    });
    const heroes = items.filter((item) => item.role === 'hero');
    const things = items.filter((item) => item.role === 'item');
    const verb = items.find((item) => item.role === 'verb')!;
    return {
      set,
      id: sentence.id,
      group: set === 'p30dev' ? 'p30-dev' : (sentence.group ?? 'test'),
      tags: sentence.tags ?? [],
      genre: depth.genre,
      heroAction: judged?.draft.spec?.heroAction ?? null,
      playable: depth.playable,
      robotWins: depth.bot.end === 'won',
      idleLoses: depth.idle.end === 'lost',
      robotInClip: judged?.draft.clip?.robot ?? null,
      heroModel: heroes.length === 0 ? null : heroes.every((item) => item.drawn),
      itemModel: things.filter((item) => item.drawn).length,
      itemBox: things.filter((item) => item.why === 'no-model').length,
      itemOf: things.length,
      verbRecognized: verb.recognized,
      items,
    };
  });
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
    heroRecognized: share(heroJudged.filter((row) => row.items.filter((item) => item.role === 'hero').every((item) => item.recognized)).length, heroJudged.length),
    itemModel: share(rows.reduce((sum, row) => sum + row.itemModel, 0), itemOf),
    itemBox: share(rows.reduce((sum, row) => sum + row.itemBox, 0), itemOf),
    itemInSpec: share(rows.reduce((sum, row) => sum + row.items.filter((item) => item.role === 'item' && item.why !== 'not-in-spec').length, 0), itemOf),
    verbRead: share(rows.filter((row) => ['ok', 'not-recognized'].includes(row.items.find((item) => item.role === 'verb')!.why)).length, rows.length),
    playable: share(rows.filter((row) => row.playable).length, rows.length),
    robotWins: share(rows.filter((row) => row.robotWins).length, rows.length),
    idleLoses: share(rows.filter((row) => row.idleLoses).length, rows.length),
    genres: Object.fromEntries(Object.entries(genres).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

function verbBy(rows: readonly Row[], keyOf: (row: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const row of rows.filter((row) => row.verbRecognized !== null)) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([key, part]) => [key, share(part.filter((row) => row.verbRecognized).length, part.length)]),
  );
}

/** Skupiny ztrát `why × role × žánr` podle počtu postižených vět. */
function lossGroups(rows: readonly Row[]) {
  const groups = new Map<string, { ids: Set<string>; items: string[] }>();
  for (const row of rows) {
    for (const item of row.items) {
      if (item.why === 'ok') continue;
      const key = `${item.why}|${item.role}|${row.genre}`;
      const group = groups.get(key) ?? { ids: new Set<string>(), items: [] };
      group.ids.add(`${row.set}:${row.id}`);
      group.items.push(`${row.id}:${item.item}`);
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, sentences: group.ids.size, items: group.items }))
    .sort((a, b) => b.sentences - a.sentences || a.key.localeCompare(b.key));
}

/** Verdikt slovesa O8 proti T10 po větách: kolik vět se pohnulo (šum soudce + změna hry). */
function verbFlips(rows: readonly Row[], t10: readonly Row[]) {
  const before = new Map(t10.map((row) => [`${row.set}:${row.id}`, row]));
  const gained: string[] = [];
  const lost: string[] = [];
  for (const row of rows) {
    const old = before.get(`${row.set}:${row.id}`);
    if (old === undefined || old.verbRecognized === null || row.verbRecognized === null) continue;
    if (row.verbRecognized && !old.verbRecognized) gained.push(`${row.id}${old.genre === row.genre ? '' : ' (genre)'}`);
    if (!row.verbRecognized && old.verbRecognized) lost.push(`${row.id}${old.genre === row.genre ? '' : ' (genre)'}`);
  }
  return { gained, lost };
}

const DEV_GROUPS = ['unknown-verb', 'non-game', 'fantasy', 'mix'];
const TEST_TAGS = ['non-game', 'unknown-verb', 'fantasy'];

it('writes evals/play/p37/o8.json', async () => {
  await loadRapier();
  const t10 = readJson(here('../p37a/after.json')) as { after: { summary: Record<string, ReturnType<typeof summary>> }; rows: { after: Row[] } };
  const dev = [...rowsOf('p37a', sentencesOf('../p37a/dev-150.json')), ...rowsOf('p30dev', sentencesOf('../p30/dev.json'))];
  const test = rowsOf('test', sentencesOf('../p30/test-200.json'));
  const seal = readJson(here('../p30/test-opened.json'));
  const dev150 = dev.filter((row) => row.set === 'p37a');
  const report = {
    about: 'P37 O8: the word draft without the director on the merged P37 A+B+C+D, dev-150 and P30 dev against P37A T10, plus the one opening of the sealed test-200. Numbers of the test set are reported unchanged and nothing is tuned on them. See o8.md.',
    runs: RUNS,
    seal,
    dev: {
      t10: { p37a: t10.after.summary.p37a, 'p30-dev': t10.after.summary['p30-dev'] },
      summary: {
        p37a: summary(dev150),
        ...Object.fromEntries(DEV_GROUPS.map((group) => [group, summary(dev150.filter((row) => row.group === group))])),
        'p30-dev': summary(dev.filter((row) => row.set === 'p30dev')),
      },
      verbByGenre: verbBy(dev150, (row) => row.genre),
      verbByHeroAction: verbBy(dev150, (row) => row.heroAction ?? 'none'),
      verbFlips: verbFlips(dev, t10.rows.after),
    },
    test: {
      summary: { all: summary(test), ...Object.fromEntries(TEST_TAGS.map((tag) => [tag, summary(test.filter((row) => row.tags.includes(tag)))])) },
      verbByGenre: verbBy(test, (row) => row.genre),
      verbByHeroAction: verbBy(test, (row) => row.heroAction ?? 'none'),
    },
    losses: { dev: lossGroups(dev), test: lossGroups(test) },
    rows: { dev, test },
  };
  writeFileSync(here('./o8.json'), `${JSON.stringify(report, null, 1)}\n`);
}, 30 * 60_000);
