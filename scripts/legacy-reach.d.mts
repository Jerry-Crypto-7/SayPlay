/** Typy k `legacy-reach.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export interface Reach {
  files: string[];
  entries: string[];
  reachable: Set<string>;
  parent: Map<string, string | null>;
  deletable: string[];
  tests: { kept: string[]; deletable: string[]; mixed: string[] };
  support: { kept: string[]; deletable: string[] };
}

export declare function analyze(root: string, options?: { exclude?: RegExp; files?: string[] }): Reach;
export declare function why(result: Reach, file: string): string[] | null;
export declare function check(root: string, options: { deleted: string[]; exclude?: RegExp }): { problems: string[] };
