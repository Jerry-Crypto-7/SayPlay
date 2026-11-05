#!/usr/bin/env node
/**
 * Export pro nasazení z archivu (P71A T6).
 *
 *   node scripts/cloud/export-for-deploy.mjs <ref> [--out <prázdná složka>]
 *
 * `git archive <ref>` rozbalí do čisté složky (výchozí `os.tmpdir()/sayplay-export-*`),
 * přidá `.vercel/project.json` z hlavního checkoutu a vypíše strom (`<ref>^{tree}`)
 * a přesný příkaz `vercel deploy`. **Sám nic nenasazuje** – nasazení spouští člověk
 * nebo agent s jeho souhlasem. Proč z archivu: Vercel neumí spárovat autora commitu
 * a nasazení z gitu zůstane BLOCKED; archiv navíc nese jen commitnutý stav, nic
 * z pracovního stromu.
 *
 * Exit 0 = export hotový, 2 = špatný ref, chybějící `.vercel/project.json` nebo
 * neprázdná cílová složka.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Jen znaky jména větve, tagu nebo sha s `^`/`~`; nic, co by git vzal jako přepínač nebo shell jako příkaz. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

/** Důvod odmítnutí refu, nebo null. Vypsaný příkaz se kopíruje do shellu, proto přísně. */
export function refProblem(ref) {
  if (typeof ref !== 'string' || ref === '') return 'chybí <ref>';
  if (!SAFE_REF.test(ref) || ref.includes('..') || ref.includes('@{')) return `ref "${ref}" obsahuje nepovolené znaky`;
  return null;
}

/** Přesný příkaz pro nasazení exportu; strom jde do buildu, `/api/build-id` ho pak vrátí. */
export function deployCommand(tree) {
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`strom "${tree}" není 40 znaků hex`);
  return `vercel deploy --prod --yes --build-env WORLDSMITH_BUILD_TREE=${tree}`;
}

function git(args, options = {}) {
  const run = spawnSync('git', args, { encoding: 'utf-8', ...options });
  if (run.status !== 0) return null;
  return run.stdout.trim();
}

/** `.vercel/project.json` v tomto checkoutu, jinak v hlavním (worktree ho nemá). */
function findVercelProject() {
  const top = git(['rev-parse', '--show-toplevel']);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const candidates = [top, common && dirname(common)].filter(Boolean).map((root) => join(root, '.vercel', 'project.json'));
  return candidates.find((file) => existsSync(file)) ?? null;
}

function fail(message) {
  console.error(`export-for-deploy: ${message}`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ref, flag, outArg] = process.argv.slice(2);
  const problem = refProblem(ref);
  if (problem) fail(problem);
  if (flag !== undefined && (flag !== '--out' || !outArg)) fail('jediný přepínač je --out <složka>');

  const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (!sha) fail(`ref "${ref}" neukazuje na commit`);
  const tree = git(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`]);
  const project = findVercelProject();
  if (!project) fail('chybí .vercel/project.json (vercel link v hlavním checkoutu)');

  let out;
  if (outArg) {
    out = resolve(outArg);
    if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} není prázdná`);
    mkdirSync(out, { recursive: true });
  } else {
    out = mkdtempSync(join(tmpdir(), 'sayplay-export-'));
  }

  // tar s relativní cestou a cwd: GNU tar z Git Bash bere `C:` v cestě jako vzdálený stroj.
  const archive = 'export.tar';
  if (git(['archive', '--format=tar', '-o', join(out, archive), sha]) === null) fail('git archive selhal');
  const untar = spawnSync('tar', ['-xf', archive], { cwd: out, encoding: 'utf-8' });
  if (untar.status !== 0) fail(`tar selhal: ${untar.stderr}`);
  rmSync(join(out, archive));
  mkdirSync(join(out, '.vercel'), { recursive: true });
  copyFileSync(project, join(out, '.vercel', 'project.json'));

  console.log(`ref     ${ref} -> ${sha}`);
  console.log(`tree    ${tree}`);
  console.log(`export  ${out}`);
  console.log('\nNasazení (jen se souhlasem majitele):');
  console.log(`  cd "${out}"`);
  console.log(`  ${deployCommand(tree)}`);
}
