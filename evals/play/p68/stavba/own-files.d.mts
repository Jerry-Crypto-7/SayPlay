/**
 * Typy k `own-files.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

export const OWN_GLOBS: readonly string[];
export function isOwnPath(path: string): boolean;
export function foreignPaths(paths: readonly string[]): string[];
