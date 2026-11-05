/**
 * Třída hrdiny ze slov (P70E): list bez závislostí, ať ho čtečka věty (`intent/extract.ts`) smí načíst bez
 * kruhu přes `genre/index` → `draft/controls` → `intent/extract`.
 */

import type { ModelClass } from './contract';

/**
 * Slova tříd modelů – zrcadlo `CLASS_WORDS` z `assets/manifest.ts`, který je
 * neexportuje a není soubor P32B. Liší se jen doplněným koštětem.
 */
const CLASS_WORDS: Readonly<Record<ModelClass, readonly string[]>> = {
  bird: ['bird', 'penguin', 'eagle', 'parrot', 'duck', 'owl', 'chicken', 'hen', 'crow', 'pigeon', 'seagull', 'hawk', 'flamingo', 'swan', 'goose'],
  animal: ['animal', 'cat', 'kitten', 'dog', 'puppy', 'fox', 'bear', 'rabbit', 'bunny', 'pig', 'cow', 'horse', 'mouse', 'monkey', 'lion', 'tiger', 'wolf', 'deer', 'frog', 'fish', 'turtle', 'snake', 'hamster', 'shark'],
  robot: ['robot', 'android', 'droid', 'mech', 'cyborg', 'bot'],
  vehicle: ['car', 'truck', 'bus', 'bike', 'bicycle', 'motorcycle', 'kart', 'tank', 'train', 'tractor', 'taxi', 'van'],
  boat: ['boat', 'ship', 'sailboat', 'yacht', 'submarine', 'canoe', 'raft', 'ferry'],
  aircraft: ['plane', 'airplane', 'jet', 'helicopter', 'rocket', 'spaceship', 'ufo', 'drone', 'balloon', 'broom', 'broomstick'],
  humanoid: ['man', 'woman', 'boy', 'girl', 'kid', 'child', 'person', 'hero', 'chef', 'firefighter', 'pirate', 'knight', 'wizard', 'princess', 'prince', 'ninja', 'astronaut'],
  monster: ['monster', 'ghost', 'zombie', 'dragon', 'alien', 'skeleton', 'goblin', 'troll', 'ogre', 'vampire'],
  prop: [],
};

const CLASS_OF_WORD: ReadonlyMap<string, ModelClass> = new Map(Object.entries(CLASS_WORDS).flatMap(([kind, words]) => words.map((word) => [word, kind as ModelClass] as const)));

const forms = (word: string): string[] => [word, word.replace(/ies$/, 'y'), word.replace(/es$/, ''), word.replace(/s$/, '')];

/** Třída hrdiny podle posledního slova, které nějakou jmenuje („pirate ship“ → loď); `null` = slova třídu neznají. */
export function heroClass(label: string): ModelClass | null {
  const words = label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  for (const word of words.reverse()) {
    const kind = forms(word)
      .map((form) => CLASS_OF_WORD.get(form))
      .find((found) => found !== undefined);
    if (kind !== undefined) return kind;
  }
  return null;
}
