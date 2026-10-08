import { recipeKey } from '../compose/recipe';
import { assemblyOfCell, liveCells } from '../compose/allowed';
import { compileRecipe } from '../compose/compile';
import { readGenreAnswer, readRecipeAnswer, readRecipeContent } from './read';
/**
 * Ověřené příklady do promptu režiséra (P30A T8): k větě 3–5 nejbližších her
 * z `examples.json`, deterministicky podle slov věty. Každý příklad je věta
 * a odpověď `{plan, spec}` se `GenreSpec` (P32B T4), kterou robot dohrál
 * k výhře (hlídá `__tests__/retrieval.test.ts`), a žádná věta nepatří do
 * vývojové ani zapečetěné testovací sady P30 – jinak by měření na nich četlo
 * vlastní odpověď. Do promptu jdou jen příklady v režimu `ready`: režim, který
 * schéma odpovědi nenabízí, by model učil odpověď, kterou napsat nesmí.
 *
 * Zapíná `PLAY_DIRECTOR_EXAMPLES=on` (`src/app/api/play/_director.ts`); bez ní
 * je prompt bajtově stejný jako předtím.
 */

import { canonicalHash } from '@/ir/worlddoc';

import type { GenreModule, GenreSpec } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';
import { extractIntent } from '../intent/extract';

import { readyModes } from './answer-schema';
import EXAMPLES from './examples.json';

export interface DirectorExample {
  readonly id: string;
  readonly sentence: string;
  readonly answer: Readonly<Record<string, unknown>>;
}

export const DIRECTOR_EXAMPLES: readonly DirectorExample[] = EXAMPLES;

/** `GenreSpec` z odpovědi příkladu. */
export const exampleSpec = (example: DirectorExample): GenreSpec => example.answer.spec as GenreSpec;

/** Příklady, jejichž režim dnes hraje; jen z nich se vybírá. */
export function exampleReady(example: DirectorExample): boolean {
  const raw = example.answer.spec as Record<string, unknown>;
  if (raw && 'recipe' in raw) return readRecipeAnswer(example.answer).ok;
  const spec = exampleSpec(example), module = GENRE_MODULES[spec.genre] as GenreModule | undefined;
  return module !== undefined && readyModes(module).includes(spec.mode);
}
export function exampleGame(example: DirectorExample) {
  const raw = example.answer.spec as Record<string, unknown>;
  if (!raw || !('recipe' in raw)) return readGenreAnswer(example.answer);
  const read = readRecipeAnswer(example.answer);
  if (!read.ok) return read;
  const cell = liveCells().find(cell => recipeKey(cell.recipe) === recipeKey(read.value.recipe))!;
  const {recipe,unmet:_unmet,...content}=read.value;
  const checked=readRecipeContent(cell,content);
  if (!checked.ok) return checked;
  return {ok:true as const,spec:compileRecipe({...assemblyOfCell(cell,checked.value),...recipe})};
}
const READY_EXAMPLES = DIRECTOR_EXAMPLES.filter(exampleReady);

/** Verze sady příkladů do klíče cache: jiné příklady = jiný prompt. */
export const EXAMPLES_VERSION = canonicalHash(DIRECTOR_EXAMPLES);

export const EXAMPLES_MIN = 3;
export const EXAMPLES_MAX = 5;

/**
 * Strop bloku příkladů ve znacích. 3600 znaků anglického JSON je ~900 tokenů
 * (~4 znaky na token), tedy méně, než kolik má sám systémový prompt (~4 900
 * znaků). gpt-oss-20b u Together za 0,05 USD/Mtok vstupu to zdraží o ~0,00005 USD
 * na volání a nejhorší případ stropu utrácení (znak = token) o 0,00018 USD.
 * Pět průměrných příkladů se vejde; delší blok se krátí odzadu, nejvýš na tři.
 */
export const EXAMPLES_MAX_CHARS = 3600;

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'by', 'for', 'with', 'from', 'into', 'onto', 'its', 'it', 'his', 'her', 'their', 'your', 'you', 'while', 'as', 'is', 'are', 'be', 'has', 'have', 'can', 'up', 'down', 'over', 'past', 'through', 'between', 'back']);

/** Slova věty bez spojek a předložek; koncové `s` pryč, ať `logs` potká `log`. */
export function sentenceWords(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

/** Blok do uživatelské zprávy: jeden příklad na řádek. */
export function examplesBlock(examples: readonly DirectorExample[]): string {
  return [
    'Verified games for similar sentences (the robot played each one to a win). Follow their shape, not their nouns:',
    ...examples.map((example) => JSON.stringify({ sentence: example.sentence, answer: example.answer })),
  ].join('\n');
}

/**
 * Nejbližší příklady: sdílená slova vážená vzácností v sadě (vzácné slovo
 * řekne víc než „game“), plus malý bonus za žánr, který má výchozí bod.
 * Shoda se řadí podle id, takže tatáž věta dá vždy tytéž příklady.
 */
export function nearestExamples(sentence: string, genre: string | null, pool: readonly DirectorExample[] = READY_EXAMPLES): readonly DirectorExample[] {
  const words = pool.map((example) => new Set(sentenceWords(example.sentence)));
  const frequency = new Map<string, number>();
  for (const set of words) for (const word of set) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const query = new Set(sentenceWords(sentence));
  // P44C: sloveso přiblížené tabulkou („stabs“ → fight) potká příklad, který tu činnost hraje (režim nebo role obsazení).
  // Vypnutá tabulka nic nepřibližuje, takže skóre je bajtově jako dřív.
  const mapped = new Set(extractIntent(sentence).items.filter((item) => item.mapped === true).map((item) => item.verb));
  const plays = pool.map((example) => new Set<string>([exampleSpec(example).mode, ...(exampleSpec(example).cast ?? []).map((item) => item.does)]));
  const scored = pool.map((example, at) => {
    let score = exampleSpec(example).genre === genre ? 0.5 : 0;
    for (const word of words[at]!) if (query.has(word)) score += Math.log(1 + pool.length / frequency.get(word)!);
    for (const verb of mapped) if (plays[at]!.has(verb)) score += Math.log(1 + pool.length / plays.filter((set) => set.has(verb)).length);
    return { example, score };
  });
  scored.sort((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id));
  const picked = scored.slice(0, EXAMPLES_MAX).map((entry) => entry.example);
  while (picked.length > EXAMPLES_MIN && examplesBlock(picked).length > EXAMPLES_MAX_CHARS) picked.pop();
  return picked;
}
