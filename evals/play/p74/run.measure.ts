/**
 * P74 T5: čísla pro README a popis nad finálním stromem. Zapíše `run-2026-11-07.json`.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p74/run.measure.ts
 *
 * - Rychlá verze (bez režiséra) na held-out sadě `p30/test-200.json`, offline týmiž měřidly jako
 *   `../p37/o8.measure.ts` (`measureSentence`: hratelnost, robot vyhraje, nečinný prohraje; `offlineChain`:
 *   sloveso přečtené ze slov, hrdina a položky modelem). Sada byla otevřena jednou 4. 10. 2026
 *   (`p30/test-opened.json`); tady se jen znovu změří a nic se podle ní neladí. Slepý soudce se nepouští.
 * - Načtení hry do prvního snímku na emulovaných telefonech: mediány z `phones.json` (T2, zkušební produkce).
 * - AI verze: `ai.json` (T2) a stav klíče režiséra v prostředí tohoto běhu.
 * - Počet modelů katalogu: `../catalog-coverage.json` (`states.now.models`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { offlineChain } from '../../../scripts/play-fidelity.mjs';
import { measureSentence } from '../p36/depth';

type Slot = 'hero' | 'role' | 'any' | 'setting' | 'verb';
type Sentence = { readonly id: string; readonly text: string; readonly tags?: readonly string[]; readonly checklist: readonly { readonly item: string; readonly slot: Slot }[] };
type Row = {
  readonly id: string;
  readonly tags: readonly string[];
  readonly genre: string;
  readonly playable: boolean;
  readonly robotWins: boolean;
  readonly idleLoses: boolean;
  readonly verbRead: boolean;
  readonly verbWhy: string;
  readonly heroModel: boolean | null;
};
type PhoneRow = { readonly phone: string; readonly loadMs?: number; readonly pass: boolean };

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const share = (hit: number, of: number) => ({ hit, of });
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function rowsOf(sentences: readonly Sentence[]): Row[] {
  const chain = new Map(offlineChain(sentences).sentences.map((row) => [row.id, row.items]));
  return sentences.map((sentence) => {
    const depth = measureSentence({ set: 'dev', id: sentence.id, text: sentence.text });
    const items = chain.get(sentence.id)!;
    const heroes = items.filter((item) => item.slot === 'hero');
    return {
      id: sentence.id,
      tags: sentence.tags ?? [],
      genre: depth.genre,
      playable: depth.playable,
      robotWins: depth.bot.end === 'won',
      idleLoses: depth.idle.end === 'lost',
      // Jako `verbRead` v O8: sloveso se do hry dostalo (`ok`; `not-recognized` tu bez soudce nevzniká).
      verbRead: items.find((item) => item.slot === 'verb')?.why === 'ok',
      verbWhy: items.find((item) => item.slot === 'verb')?.why ?? 'none',
      heroModel: heroes.length === 0 ? null : heroes.every((item) => item.drawn),
    };
  });
}

function summary(rows: readonly Row[]) {
  const withHero = rows.filter((row) => row.heroModel !== null);
  const genres: Record<string, number> = {};
  for (const row of rows) genres[row.genre] = (genres[row.genre] ?? 0) + 1;
  return {
    sentences: rows.length,
    playable: share(rows.filter((row) => row.playable).length, rows.length),
    robotWins: share(rows.filter((row) => row.robotWins).length, rows.length),
    idleLoses: share(rows.filter((row) => row.idleLoses).length, rows.length),
    verbRead: share(rows.filter((row) => row.verbRead).length, rows.length),
    heroModel: share(withHero.filter((row) => row.heroModel).length, withHero.length),
    genres: Object.fromEntries(Object.entries(genres).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

function phones() {
  const data = readJson(here('./phones.json')) as { base: string; measuredAt: string; rows: PhoneRow[] };
  const of = (phone: string) => {
    const mine = data.rows.filter((row) => row.phone === phone);
    const load = mine.map((row) => row.loadMs).filter((value): value is number => typeof value === 'number');
    return { games: mine.length, pass: mine.filter((row) => row.pass).length, loadMedianMs: median(load), loadMinMs: Math.min(...load), loadMaxMs: Math.max(...load) };
  };
  return { file: 'evals/play/p74/phones.json', base: data.base, measuredAt: data.measuredAt, iphone: of('iphone'), pixel: of('pixel') };
}

function ai() {
  const data = readJson(here('./ai.json')) as { base: string; measuredAt: string; rows: { quickMs: number; status: string; reason?: string; aiMs: number | null }[] };
  const ready = data.rows.filter((row) => row.status === 'ready');
  return {
    file: 'evals/play/p74/ai.json',
    base: data.base,
    measuredAt: data.measuredAt,
    sentences: data.rows.length,
    quickMedianMs: median(data.rows.map((row) => row.quickMs)),
    aiReady: ready.length,
    reasons: [...new Set(data.rows.map((row) => row.reason ?? row.status))],
  };
}

// Klíč režiséra (`src/server`) a sdílená kniha útraty; bez nich místní `next start` AI verzi nepostaví.
const KEY_NAMES = ['WORLDSMITH_MODEL_KEY', 'KV_REST_API_TOKEN'];

it('writes evals/play/p74/run-2026-11-07.json', async () => {
  await loadRapier();
  const test = rowsOf((readJson(here('../p30/test-200.json')) as { sentences: Sentence[] }).sentences);
  const coverage = readJson(here('../catalog-coverage.json')) as { states: { now: { models: number } } };
  const report = {
    about: 'P74 T5: numbers for README.md and docs/submission/description.md on the final tree. Quick version on the held-out test-200 set, offline, same meters as P37 O8 (opened once on 2026-10-04, nothing tuned on it since; no vision judge in this run). Phone load times and the AI version from the P74 T2 trial deployment. Catalogue size from evals/play/catalog-coverage.json.',
    measuredOn: '2026-11-07',
    quick: { set: 'evals/play/p30/test-200.json', opened: readJson(here('../p30/test-opened.json')), summary: summary(test), byTag: Object.fromEntries(['non-game', 'unknown-verb', 'fantasy'].map((tag) => [tag, summary(test.filter((row) => row.tags.includes(tag)))])) },
    phones: phones(),
    ai: { trial: ai(), localRun: { reached: false, why: 'no director key in the environment of this run', keysChecked: KEY_NAMES, keysPresent: KEY_NAMES.filter((name) => (process.env[name] ?? '') !== ''), spendUsd: 0 } },
    catalogue: { models: coverage.states.now.models, file: 'evals/play/catalog-coverage.json' },
    rows: test,
  };
  writeFileSync(here('./run-2026-11-07.json'), `${JSON.stringify(report, null, 1)}\n`);
}, 30 * 60_000);
