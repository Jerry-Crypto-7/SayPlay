/** Typy k `readme-claims.mjs` – skript běží holým Nodem, testy jsou TypeScript. */

export declare const CLAIMS_FILE: string;
export declare const README_FILE: string;

export declare interface MeasuredNumber {
  readonly key: string;
  readonly text: string;
  readonly line: number;
}

export declare interface Claim {
  readonly id: string;
  readonly line: number;
  readonly keys: Set<string>;
  readonly date: string;
  readonly file: string;
  readonly evidence: string[];
}

export declare interface RepoView {
  readonly isPublic: (path: string) => boolean;
  readonly read: (path: string) => string;
}

export declare function measuredNumbers(markdown: string): MeasuredNumber[];
export declare function parseClaims(markdown: string): Claim[];
export declare function headingSlugs(markdown: string): Set<string>;
export declare function linkTargets(markdown: string): { target: string; line: number }[];
export declare function documentProblems(input: RepoView & {
  readonly path: string;
  readonly text: string;
  readonly claimKeys: ReadonlySet<string>;
}): string[];
export declare function claimRowProblems(claims: readonly Claim[], view: RepoView): string[];
export declare function claimDocuments(repo: string): string[];
export declare function claimProblems(repo: string): string[];
