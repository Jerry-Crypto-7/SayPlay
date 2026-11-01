#!/usr/bin/env node
/**
 * P68V T1: hlídač vlastnictví souborů pruhu P68-V (vozidla a sport: `stunt`, `minigolf`).
 *
 *   git diff --name-only origin/main...HEAD | node evals/play/p68/vozidla-sport/owned-paths.mjs
 *
 * Čte cesty ze stdin (jedna na řádek). Vrátí 0, když všechny patří pruhu; jinak vypíše cizí cesty a vrátí 1.
 * Sdílené soubory (klasifikátor, režisér, `contract.ts`, `kernel.ts`, `physics/**`, `ArcadeStage.tsx`,
 * `playwright.config.ts`, `public/**` …) vlastní P68-I – potřeba pruhu jde do `integration.md`, ne do diffu.
 * Seznam odpovídá jménům, která založila kostra P68-I T1 (README → „Kostra“).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = '(?:stunt|minigolf)';

/** Cesty, které pruh smí měnit nebo zakládat. */
export const OWNED = [
  // Moduly žánru z kostry a jejich testy.
  new RegExp(`^src/play/genre/${GAME}\\.ts$`),
  new RegExp(`^src/play/genre/__tests__/${GAME}[\\w.-]*\\.test\\.ts$`),
  // Jádro, robot a nové soubory `stunt*` / `minigolf*` přímo v `pieces/` a jejich testy.
  new RegExp(`^src/play/arcade/pieces/${GAME}[\\w.-]*\\.ts$`),
  new RegExp(`^src/play/arcade/__tests__/${GAME}[\\w.-]*\\.test\\.ts$`),
  // Scéna, kamera, efekty a dotykový adaptér.
  new RegExp(`^src/components/play/arcade/genres/${GAME}/.+$`),
  // e2e a ruční specy.
  new RegExp(`^e2e/play-${GAME}\\.spec\\.ts$`),
  new RegExp(`^e2e/fixtures/p68-${GAME}-spec\\.json$`),
  // Měření, předávací dokument a hlídače pruhu.
  /^evals\/play\/p68\/vozidla-sport\/.+$/,
];

/** Cesty ze vstupu, které pruhu nepatří (v pořadí vstupu). */
export function foreignPaths(paths) {
  return paths.filter((p) => !OWNED.some((re) => re.test(p)));
}

/** Řádky stdin na cesty: CRLF, zpětná lomítka a prázdné řádky pryč. */
export function parsePaths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line.length > 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const foreign = foreignPaths(parsePaths(readFileSync(0, 'utf8')));
  for (const p of foreign) console.log(p);
  process.exit(foreign.length === 0 ? 0 : 1);
}
