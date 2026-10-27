/**
 * Typy k `diagnose.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

export type Step = 'reader' | 'classifier' | 'compose' | 'translation' | 'publish' | 'none';

export interface Expect {
  readonly genres: readonly string[];
  readonly hero: string | null;
  readonly roles: readonly string[];
}

export interface Cast {
  readonly hero: string | null;
  readonly roles: readonly string[];
}

export interface Game {
  readonly genre: string | null;
  readonly cast: Cast;
  readonly [key: string]: unknown;
}

export interface Diagnosis {
  readonly id: string;
  readonly sentence: string;
  readonly expect: Expect;
  readonly reading: { readonly genre: string | null; readonly [key: string]: unknown };
  readonly classified: { readonly first: string | null; readonly why: string | null; readonly decided: unknown };
  readonly quickGame: Game;
  readonly readingGame: Game | null;
  readonly published: boolean;
  readonly step: Step;
  readonly location: string | null;
}

export const STEPS: readonly Step[];
export const EXPECT: Readonly<Record<'h02' | 'h11' | 'h14' | 'h15' | 'h18' | 'h19' | 'h23' | 'h24' | 's002' | 's006', Expect>>;
export function locate(step: string, root?: string): string | null;
export function admissible(genre: string | null, genres: readonly string[]): boolean;
export function castOf(spec: unknown): Cast;
export function namesCast(cast: Cast, expect: Expect): boolean;
export function divergeStep(input: {
  readonly expect: Expect;
  readonly readGenre: string | null;
  readonly classified: string | null;
  readonly readingGame: Game;
  readonly quickGame: Game;
  readonly published: boolean;
}): Step;
export function loadDeps(): Promise<unknown>;
export function gamesOf(sentence: string, reading: unknown, deps: unknown): { readonly quickGame: Game; readonly readingGame: Game | null; readonly published: boolean };
export function diagnoseSentence(row: { readonly id: string; readonly text: string }, reading: unknown, expect: Expect, deps: unknown): Diagnosis;
