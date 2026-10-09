/** Typy k `pick-nouns.mjs` pro TypeScript testy (konvence `scripts/p37d/missing-nouns.d.mts`). */

import type { NounRow } from '../p37d/missing-nouns.mjs';
import type { BodyClass } from './motion-class.mjs';

export type PickedNoun = { noun: string; why: 'hero' | 'demand' | 'confused'; class: BodyClass; flat: boolean; sentences: number };

export declare const OUT: string;
export declare const MAX_NOUNS: number;
export declare const FLAT: Set<string>;
export declare function parseList(text: string): Set<string>;
export declare function confusedOf(markdown: string): string[];
export declare function panelHeroesWithoutModel(
  baseline: { rows: { id: string; heroModel: boolean }[] },
  panel: { sentences: { id: string; text: string; checklist?: { item: string; slot: string }[] }[] },
): string[];
export declare function pickNouns(inputs: { missing: NounRow[]; heroes: string[]; confused: string[]; notModels: Set<string>; max?: number }): PickedNoun[];
export declare function pickFromRepo(): PickedNoun[];
