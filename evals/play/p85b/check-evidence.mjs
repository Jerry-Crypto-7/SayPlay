#!/usr/bin/env node
/**
 * Every path in `docs/submission/evidence.md` exists in the public repository (P85B T2).
 *
 * ```
 * node evals/play/p85b/check-evidence.mjs     exit 0 = nothing missing, 1 = at least one finding
 * ```
 *
 * Reads every inline-code span and every relative link of the evidence map. A span with a
 * space is a command: quoted arguments are dropped and its path-shaped words are checked.
 * A path is found when it exists on disk and git does not ignore it (so a clean clone has it);
 * `path:line` also needs that line to exist. Each part of the map (each `##` section with a
 * table) must have at least five rows.
 *
 * simplified: a command is checked for its paths only, not run – running every command takes
 * minutes; the map's own "Check it" column is what a reader runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MAP_FILE = 'docs/submission/evidence.md';
const MIN_ROWS = 5;

/** A word that names a repository file: has a slash or a file extension, is not a URL or a site path. */
const PATH_WORD = /^(?:[\w@.[\]-]+\/)*[\w@.[\]-]+\.(?:md|mdx|json|jsonl|mjs|cjs|js|ts|tsx|yml|yaml|example|txt|py|css|ps1)$|^(?:[\w@.[\]-]+\/)+[\w@.[\]-]+\/?$/;

/** `{ path, line }` references in one markdown text, relative links resolved against `docPath`. */
export function referencesOf(markdown, docPath = MAP_FILE) {
  const found = [];
  const here = posix.dirname(docPath);
  const text = markdown.replace(/```[\s\S]*?```/g, '');
  for (const [, link] of text.matchAll(/\]\(\s*<?([^)\s>]+)>?\s*\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#')) continue;
    const [raw, anchor] = link.split('#');
    const lineMatch = /^L(\d+)$/.exec(anchor ?? '');
    found.push({ path: posix.normalize(posix.join(here, decodeURI(raw))), line: lineMatch ? Number(lineMatch[1]) : null, from: link });
  }
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    const words = span.includes(' ') ? span.replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/) : [span];
    for (const word of words) {
      const match = /^(.+?)(?::(\d+)(?:[–-]\d+)?)?$/.exec(word.replace(/[,;]$/, ''));
      if (!match) continue;
      const [, path, line] = match;
      if (path.includes('://') || path.startsWith('/') || path.startsWith('-') || !PATH_WORD.test(path)) continue;
      found.push({ path: path.replace(/\/$/, ''), line: line === undefined ? null : Number(line), from: span });
    }
  }
  return found;
}

/** Table rows (header and divider excluded) under each `##` heading that has a table. */
export function rowsPerSection(markdown) {
  const counts = new Map();
  let section = null;
  let rows = -1;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1];
      rows = -1;
      continue;
    }
    if (section === null || !line.trim().startsWith('|')) {
      rows = -1;
      continue;
    }
    if (/^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line.trim())) continue;
    rows += 1;
    if (rows > 0) counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return counts;
}

/** Ignored and not tracked: `check-ignore` without `--no-index` never reports a tracked file. */
function gitIgnored(repo, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Findings for the map; empty = every path is there and every part has enough rows. */
export function evidenceProblems(repo = REPO) {
  const markdown = readFileSync(join(repo, MAP_FILE), 'utf8');
  const problems = [];
  const references = referencesOf(markdown);
  for (const { path, line, from } of references) {
    const absolute = join(repo, path);
    if (!existsSync(absolute)) {
      problems.push(`${path} does not exist (from \`${from}\`)`);
      continue;
    }
    if (gitIgnored(repo, path)) {
      problems.push(`${path} is ignored by git, a clean clone will not have it (from \`${from}\`)`);
      continue;
    }
    if (line !== null) {
      if (statSync(absolute).isDirectory()) {
        problems.push(`${path}:${line} is a directory, not a file`);
        continue;
      }
      const lines = readFileSync(absolute, 'utf8').split('\n').length;
      if (line < 1 || line > lines) problems.push(`${path}:${line} – the file has ${lines} lines`);
    }
  }
  const sections = rowsPerSection(markdown);
  if (sections.size === 0) problems.push(`${MAP_FILE} has no table`);
  for (const [section, rows] of sections) {
    if (rows < MIN_ROWS) problems.push(`section "${section}" has ${rows} rows, at least ${MIN_ROWS} are needed`);
  }
  return { problems, references: references.length, sections: sections.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, references, sections } = evidenceProblems();
  for (const problem of problems) console.log(`MISSING  ${problem}`);
  console.log(`check-evidence: ${references} references in ${sections} parts, ${problems.length} missing`);
  process.exit(problems.length === 0 ? 0 : 1);
}
