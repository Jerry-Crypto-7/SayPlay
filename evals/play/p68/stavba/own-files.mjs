#!/usr/bin/env node
/**
 * Strážce vlastních souborů pruhu P68-S (stavba: `buildshift`, `drawsave`). Vlastnictví je závazné podle
 * `.claude/debate/p68-decision.md`: pruh smí vytvořit a měnit jen soubory své hry; všechno ostatní vlastní P68-I
 * a každá potřeba změny jde do `evals/play/p68/stavba/integration.md`.
 *
 * Použití:
 *   node evals/play/p68/stavba/own-files.mjs                 # git diff --name-only origin/main...HEAD
 *   node evals/play/p68/stavba/own-files.mjs --base <ref>    # git diff --name-only <ref>...HEAD
 *   git diff --name-only … | node evals/play/p68/stavba/own-files.mjs --stdin
 * Exit 0 = jen vlastní cesty, exit 1 = vypíše cizí cesty.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Vlastní cesty pruhu (Pravidla běhu plánu P68-S). `*` nepřekročí `/`, `**` ano. */
export const OWN_GLOBS = [
  'src/play/genre/buildshift.ts',
  'src/play/genre/drawsave.ts',
  'src/play/arcade/pieces/buildshift*.ts',
  'src/play/arcade/pieces/drawsave*.ts',
  'src/components/play/arcade/genres/buildshift/**',
  'src/components/play/arcade/genres/drawsave/**',
  'e2e/play-buildshift.spec.ts',
  'e2e/play-drawsave.spec.ts',
  'e2e/fixtures/p68-buildshift-*.json',
  'e2e/fixtures/p68-drawsave-*.json',
  'src/play/arcade/__tests__/buildshift*.test.ts',
  'src/play/arcade/__tests__/drawsave*.test.ts',
  'src/play/genre/__tests__/buildshift.test.ts',
  'src/play/genre/__tests__/drawsave.test.ts',
  'evals/play/p68/stavba/**',
];

const toRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')}$`,
  );

const OWN = OWN_GLOBS.map(toRegExp);

const normalize = (path) => path.trim().replace(/\\/g, '/');

/** Patří cesta (od kořene repa) pruhu? */
export const isOwnPath = (path) => OWN.some((re) => re.test(normalize(path)));

/** Cesty, které pruhu nepatří, v pořadí vstupu; prázdné řádky se přeskočí. */
export const foreignPaths = (paths) => paths.map(normalize).filter((path) => path !== '' && !isOwnPath(path));

const main = () => {
  const args = process.argv.slice(2);
  let list;
  if (args.includes('--stdin')) {
    list = readFileSync(0, 'utf8');
  } else {
    const at = args.indexOf('--base');
    const base = at >= 0 ? args[at + 1] : 'origin/main';
    list = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
  }
  const paths = list.split(/\r?\n/);
  const foreign = foreignPaths(paths);
  if (foreign.length > 0) {
    console.log(`own-files: ${foreign.length} path(s) outside the P68-S lane – move the need to evals/play/p68/stavba/integration.md:`);
    for (const path of foreign) console.log(`  ${path}`);
    process.exit(1);
  }
  console.log(`own-files: ok (${paths.filter((p) => p.trim() !== '').length} own path(s))`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
