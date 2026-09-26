/**
 * Čipy remixu a návěští tříd věty – bez schémat specu a registru, protože je
 * čte i živá změna v prohlížeči (`live-intent.ts` → `LiveBox`), a arkáda
 * schémata GameSpec nenese (`arcade-bundle.test.ts`, P28E T5). Zbytek
 * remixu (`remix.ts`) je znovu exportuje.
 */

import type { RemixClass } from '../contracts';
import type { GameSpecV1 } from '../spec';

export const REMIX_CHIPS = ['harder', 'twist', 'swap_enemy', 'reskin'] as const;
export type RemixChip = (typeof REMIX_CHIPS)[number];

/** Doslova `docs/play/pack/PRODUCT_COPY.md`; test drží shodu se souborem. */
export const REMIX_CHIP_LABELS: Readonly<Record<RemixChip, string>> = {
  harder: 'Make it harder',
  twist: 'Add a twist',
  swap_enemy: 'Swap the enemy',
  reskin: 'Change the world, keep the rules',
};

const CHIP_CLASS: Readonly<Record<RemixChip, RemixClass>> = { harder: 'parameter', swap_enemy: 'parameter', twist: 'mechanic', reskin: 'presentation' };

/** Návěští tříd remixu; sdílí je i živá změna (`live-intent.ts`), aby obě cesty četly větu stejně. */
export const MECHANIC_VERBS = /\b(stun|stuns|freeze|freezes|carry|carries|press|presses|collect|collects|chase|chases)\b/i;
export const TOPOLOGY_WORDS = /\b(bigger|smaller|maze|rooms|islands|layout)\b/i;
export const OBJECTIVE_WORDS = /\b(instead|goal|win by|objective)\b/i;
export const PARAMETER_WORDS = /\b(twice as fast|faster|slower|more|fewer|\d+ seconds)\b/i;
export const PRESENTATION_WORDS = /\b(neon|sci-fi|forest|underwater|make it look|theme)\b/i;

export function chipOf(sentence: string): RemixChip | null {
  const text = sentence.trim().toLowerCase();
  return REMIX_CHIPS.find((chip) => chip === text || REMIX_CHIP_LABELS[chip].toLowerCase() === text) ?? null;
}

/** Deterministická třída věty; `parent` je tu pro kontrakt, pravidla zatím čtou jen text. */
export function classifyRemix(sentence: string, _parent: GameSpecV1): RemixClass {
  const chip = chipOf(sentence);
  if (chip !== null) return CHIP_CLASS[chip];
  if (MECHANIC_VERBS.test(sentence)) return 'mechanic';
  if (TOPOLOGY_WORDS.test(sentence)) return 'topology';
  if (OBJECTIVE_WORDS.test(sentence)) return 'objective';
  if (PARAMETER_WORDS.test(sentence)) return 'parameter';
  if (PRESENTATION_WORDS.test(sentence)) return 'presentation';
  return 'mechanic';
}
