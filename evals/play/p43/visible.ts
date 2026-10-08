/**
 * P43 měřidlo viditelnosti (T2): po větách panelu sloveso poznané v klipu,
 * totéž jen u vět, kde svědek akci potvrdil (offline řetěz: robot sloveso
 * zahrál a hra se změnila), hrdina modelem, hrdina poznaný, položka modelem.
 *
 * Čte jen `panel.json`. Zapečetěnou sadu otevře výhradně `setOf({ openSealedOnce: true })`
 * a jen tehdy, když běh klipu už pečeť zlomil (`sealed-opened.json`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { offlineChain } from '../../../scripts/play-fidelity.mjs';

type Slot = 'hero' | 'role' | 'any' | 'setting' | 'verb';
export type Sentence = { readonly id: string; readonly text: string; readonly checklist: readonly { readonly item: string; readonly slot: Slot }[] };
type Clip = { readonly judge?: { readonly draft?: Record<string, boolean> }; readonly judgeFrames?: { readonly draft?: number } };
type ChainItem = { readonly item: string; readonly slot: Slot; readonly drawn: boolean };

export type Row = {
  readonly id: string;
  readonly genre: string;
  /** Svědek: offline řetěz dokázal, že hra sloveso hraje. */
  readonly witnessed: boolean;
  readonly verbRecognized: boolean | null;
  readonly heroModel: boolean | null;
  readonly heroRecognized: boolean | null;
  readonly itemModel: number;
  readonly itemOf: number;
};

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** Panel, nebo jednou na konci zapečetěná sada – a ta jen po zlomené pečeti. */
export function setOf({ openSealedOnce = false, dir = here('.') }: { openSealedOnce?: boolean; dir?: string } = {}): readonly Sentence[] {
  if (!openSealedOnce) return (readJson(`${dir}/panel.json`) as { sentences: Sentence[] }).sentences;
  if (!existsSync(`${dir}/sealed-opened.json`)) throw new Error('sealed set is closed – open it once with play-fidelity.mjs run --set p43-sealed --open-sealed-once');
  return (readJson(`${dir}/sealed-100.json`) as { sentences: Sentence[] }).sentences;
}

/** Klip běhu `evals/play/fidelity/runs/<run>/<id>.json`, jen verdikt nad třemi snímky. */
export function clipOf(runDir: string, id: string): Clip | null {
  const path = `${runDir}/${id}.json`;
  if (!existsSync(path)) return null;
  const result = readJson(path) as Clip;
  return result.judgeFrames?.draft === 3 ? result : null;
}

export function rowsOf(sentences: readonly Sentence[], clip: (id: string) => Clip | null): Row[] {
  const chain = new Map(offlineChain(sentences).sentences.map((row: { readonly id: string; readonly genre: string; readonly items: readonly ChainItem[] }) => [row.id, row]));
  return sentences.map((sentence) => {
    const { genre, items } = chain.get(sentence.id)!;
    const seen = clip(sentence.id)?.judge?.draft ?? null;
    const heroes = items.filter((item) => item.slot === 'hero');
    const things = items.filter((item) => item.slot === 'role' || item.slot === 'any');
    const verb = items.find((item) => item.slot === 'verb')!;
    return {
      id: sentence.id,
      genre,
      witnessed: verb.drawn,
      verbRecognized: seen === null ? null : seen[verb.item] === true,
      heroModel: heroes.length === 0 ? null : heroes.every((item) => item.drawn),
      heroRecognized: heroes.length === 0 || seen === null ? null : heroes.every((item) => seen[item.item] === true),
      itemModel: things.filter((item) => item.drawn).length,
      itemOf: things.length,
    };
  });
}

const share = (hit: number, of: number) => ({ hit, of, share: of === 0 ? null : Math.round((hit / of) * 1000) / 1000 });

export function summary(rows: readonly Row[]) {
  const judged = rows.filter((row) => row.verbRecognized !== null);
  const witnessed = judged.filter((row) => row.witnessed);
  const withHero = rows.filter((row) => row.heroModel !== null);
  const heroJudged = rows.filter((row) => row.heroRecognized !== null);
  return {
    sentences: rows.length,
    judged: judged.length,
    verbRecognized: share(judged.filter((row) => row.verbRecognized).length, judged.length),
    verbRecognizedWitnessed: share(witnessed.filter((row) => row.verbRecognized).length, witnessed.length),
    witnessed: share(rows.filter((row) => row.witnessed).length, rows.length),
    heroModel: share(withHero.filter((row) => row.heroModel).length, withHero.length),
    heroRecognized: share(heroJudged.filter((row) => row.heroRecognized).length, heroJudged.length),
    itemModel: share(rows.reduce((sum, row) => sum + row.itemModel, 0), rows.reduce((sum, row) => sum + row.itemOf, 0)),
  };
}
