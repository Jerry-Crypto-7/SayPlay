/**
 * Ověřené příklady do promptu režiséra (P30A T8): k větě 3–5 nejbližších her
 * z `examples.json`, deterministicky podle slov věty. Každý příklad je věta
 * a kompaktní odpověď, kterou robot dohrál k výhře (hlídá
 * `__tests__/retrieval.test.ts`), a žádná věta nepatří do vývojové ani
 * zapečetěné testovací sady P30 – jinak by měření na nich četlo vlastní odpověď.
 *
 * Zapíná `PLAY_DIRECTOR_EXAMPLES=on` (`src/app/api/play/_director.ts`); bez ní
 * je prompt bajtově stejný jako předtím.
 */

import { canonicalHash } from '@/ir/worlddoc';

import EXAMPLES from './examples.json';

export interface DirectorExample {
  readonly id: string;
  readonly sentence: string;
  readonly answer: Readonly<Record<string, unknown>>;
}

export const DIRECTOR_EXAMPLES: readonly DirectorExample[] = EXAMPLES;

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
 * řekne víc než „game“), plus malý bonus za ovládání, které má výchozí bod.
 * Shoda se řadí podle id, takže tatáž věta dá vždy tytéž příklady.
 */
export function nearestExamples(sentence: string, control: string | null, pool: readonly DirectorExample[] = DIRECTOR_EXAMPLES): readonly DirectorExample[] {
  const words = pool.map((example) => new Set(sentenceWords(example.sentence)));
  const frequency = new Map<string, number>();
  for (const set of words) for (const word of set) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const query = new Set(sentenceWords(sentence));
  const scored = pool.map((example, at) => {
    let score = example.answer.control === control ? 0.5 : 0;
    for (const word of words[at]!) if (query.has(word)) score += Math.log(1 + pool.length / frequency.get(word)!);
    return { example, score };
  });
  scored.sort((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id));
  const picked = scored.slice(0, EXAMPLES_MAX).map((entry) => entry.example);
  while (picked.length > EXAMPLES_MIN && examplesBlock(picked).length > EXAMPLES_MAX_CHARS) picked.pop();
  return picked;
}
