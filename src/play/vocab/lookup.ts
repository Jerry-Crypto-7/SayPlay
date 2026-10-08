/**
 * Vyhledání neznámého slovesa v tabulce P44C (`verbs.json`, staví `scripts/vocab/build.mjs`).
 *
 * Jen čtení mapy – žádný model ani náhoda v cestě návrhu. Tabulka žije jen na serveru: návrh
 * i režisér běží v API routě, klient odsud nic neimportuje. Volá se jen pro sloveso, které ruční
 * tabulka v `intent/extract.ts` nezná; `PLAY_VOCAB=off` vrací chování před P44C.
 */
import type { HeroAction } from '../hero-action';
import type { ActionId, MoveId, ObjectiveId } from '../intent/contract';
import manifest from './manifest.json';
import table from './verbs.json';

export type VocabAxis = 'move' | 'action' | 'objective';

export interface VocabVerb {
  /** Základní tvar slovesa z věty („stabbing“ → „stab“) – tak ho hra jmenuje v přiznání. */
  readonly lemma: string;
  /** Osa záměru a id na ní; `null`, když sloveso nese jen pózu hrdiny. */
  readonly axis: VocabAxis | null;
  readonly id: MoveId | ActionId | ObjectiveId | null;
  readonly hero: Exclude<HeroAction, 'none'> | null;
  /** Jistota stavby 0–1 (1 = kotevní sloveso). */
  readonly score: number;
}

const targets = table.targets as readonly string[];
const verbs = table.verbs as unknown as Readonly<Record<string, readonly [number, number, number]>>;

/** Kandidáti na lemma z pravidelného tvaru: lemma, -s/-es/-ies, -ing a -ed i se zdvojenou souhláskou a ztraceným „e“. */
function lemmas(word: string): string[] {
  const out = [word];
  const strip = (suffix: string): string | null => (word.endsWith(suffix) && word.length - suffix.length >= 2 ? word.slice(0, -suffix.length) : null);
  const ies = strip('ies');
  if (ies !== null) out.push(`${ies}y`);
  const es = strip('es');
  if (es !== null) out.push(es);
  const s = strip('s');
  if (s !== null && !word.endsWith('ss')) out.push(s);
  for (const suffix of ['ing', 'ed']) {
    const stem = strip(suffix);
    if (stem === null) continue;
    if (suffix === 'ed' && stem.endsWith('i')) out.push(`${stem.slice(0, -1)}y`);
    out.push(stem, `${stem}e`);
    if (stem.length >= 3 && stem.at(-1) === stem.at(-2)) out.push(stem.slice(0, -1));
  }
  return out;
}

/** Verze tabulky pro klíče cache (prvních 12 znaků SHA `verbs.json` z manifestu); `null` = tabulka vypnutá. */
export function vocabVersion(): string | null {
  return process.env.PLAY_VOCAB === 'off' ? null : manifest.outputs.verbs.sha256.slice(0, 12);
}

export function vocabVerb(word: string): VocabVerb | null {
  if (process.env.PLAY_VOCAB === 'off') return null;
  const lower = word.toLowerCase();
  const lemma = lemmas(lower).find((candidate) => Object.hasOwn(verbs, candidate));
  if (lemma === undefined) return null;
  const [axisIndex, heroIndex, score] = verbs[lemma];
  const [axis, id] = axisIndex === -1 ? [null, null] : targets[axisIndex].split(':');
  return {
    lemma,
    axis: axis as VocabAxis | null,
    id: id as VocabVerb['id'],
    hero: heroIndex === -1 ? null : (targets[heroIndex].slice('hero:'.length) as VocabVerb['hero']),
    score: score / 1000,
  };
}
