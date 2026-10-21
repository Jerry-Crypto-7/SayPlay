/** Typy k `usage-tally.mjs` pro TypeScript testy. */

export type Role = 'hero' | 'enemy' | 'cast' | 'scenery' | 'flora';
export type CensusRow = { id: string; setting: string; look: string; kit: number; hero: string; enemy: string; cast: string[]; scenery: string[]; flora: string[] };
export type ModelUsage = { id: string; scenes: number; uses: number; roles: Partial<Record<Role, number>>; settings: Record<string, number> };
export type SettingUsage = { setting: string; scenes: number; looks: Record<string, number>; kit: number };

export declare const SETS: string[];
export declare const TOP: number;
export declare const SAMPLE: number;
export declare const SEED: number;
export declare function tally(
  rows: CensusRow[],
  known: ReadonlySet<string>,
  options?: { top?: number },
): { models: ModelUsage[]; top: string[]; settings: SettingUsage[]; unknown: Record<string, { scenes: number; uses: number }> };
export declare function sampleTail(catalogIds: string[], top: string[], options: { seed: number; count: number }): string[];
