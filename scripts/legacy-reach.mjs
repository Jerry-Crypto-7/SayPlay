#!/usr/bin/env node
/**
 * Co z kódu potřebuje Sayplay `/play` – a co je pozůstatek starého produktu.
 *
 * Starý WORLDSTREAM (`/studio`) a `/play` sdílí jádro mřížky, takže celé „staré"
 * adresáře smazat nejdou. Tenhle skript postaví graf importů od vstupních bodů
 * `/play` a řekne, které soubory na ně nikdo nedosáhne. Graf je regex nad
 * zdrojem, ne překladač: chytá `import … from`, `export … from`, `import()`,
 * `require()`, `new URL(…, import.meta.url)`, CSS `@import` a doslovné cesty
 * do repa (`'evals/play/x.json'`). Chybu na straně „víc dosažitelného" unese
 * (soubor zůstane), opačnou chytá brána: build + e2e po každém řezu.
 *
 *   node scripts/legacy-reach.mjs --report             počty po adresářích
 *   node scripts/legacy-reach.mjs --list [adresář…]    smazatelné soubory
 *   node scripts/legacy-reach.mjs --why <soubor>       cesta importů od vstupu
 *   node scripts/legacy-reach.mjs --check [adresář…]   po smazání: exit 1, když
 *                                                      chybí vstup nebo soubor,
 *                                                      který něco importuje
 *   --exclude <regex>                                  soubor ber jako smazaný
 *
 * **Test není vstupní bod ani důvod ponechání.** Test (`*.test.*`, cokoli pod
 * `__tests__/` a `__fixtures__/`) jde smazat, když všechno, co testuje, je nedosažitelné; když
 * testuje obojí, je „mixed" a rozhodne člověk.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODE = /\.(?:tsx?|[cm][jt]s|jsx?|json|jsonl|css)$/;
const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];
const SCOPE = /^(?:src|scripts|evals|e2e|ops)\//;

/** Vstupní body `/play` (plán P44D T1). Skripty z package.json, hooků a CI se přidají za běhu. */
const ENTRY_GLOBS = [
  'src/app/play/**',
  'src/app/api/play/**',
  'src/app/page.tsx',
  'src/app/layout.tsx',
  'src/app/api/health/**',
  'src/app/api/build-id/**',
  'evals/play/**',
  'e2e/play-*.spec.ts',
  'e2e/p3*.spec.ts',
  'e2e/interface-language.spec.ts',
  // Nástroje nasazení /play (gen3d, llm, watchdog); do src nesahají, ale skripty volat můžou.
  'ops/**',
  // Konfigurace, které nástroje načtou samy bez zmínky v package.json.
  'next.config.mjs',
  'playwright.config.ts',
  'vitest.config.mts',
  // Ambientní deklarace nikdo neimportuje, tsc je čte sám.
  '**/*.d.ts',
];

/** Kde hledat volání skriptů: příkazy, které repo spouští samo. */
const COMMAND_SOURCES = ['package.json', '.githooks', '.github/workflows', '.claude/start-demo.cmd', 'vercel.json'];

const globToRegex = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?')
      .replace(/\u0001/g, '.*')}$`,
  );

export const isTest = (file) => /(?:^|\/)__(?:tests|fixtures)__\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);
const isTestFile = (file) => /\.test\.[cm]?[jt]sx?$/.test(file);

function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    // Ve fixtuře bez repa by git odpověděl za nadřazené repo; prázdný výstup = projdi disk.
    const files = out.split('\n').filter((file) => file && existsSync(join(root, file)));
    if (files.length > 0 && existsSync(join(root, '.git'))) return files;
  } catch {
    // není repo – projdi disk
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk('');
  return files;
}

function readCommands(root) {
  const texts = [];
  for (const source of COMMAND_SOURCES) {
    const path = join(root, source);
    if (!existsSync(path)) continue;
    try {
      texts.push(readFileSync(path, 'utf8'));
    } catch {
      for (const name of readdirSync(path)) texts.push(readFileSync(join(path, name), 'utf8'));
    }
  }
  return texts.join('\n').replace(/\\/g, '/');
}

const SPEC_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
  /@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g,
];
const TEMPLATE_IMPORT = /\b(?:import|require)\s*\(\s*`([^`$]*)\$\{/g;
const REPO_PATH = /['"`](?:\.\/)?((?:src|scripts|evals|e2e|ops|data)\/[^'"`\s$*{}]+)['"`]/g;

function resolve(from, spec, has) {
  const clean = spec.replace(/[?#].*$/, '');
  let base;
  if (clean.startsWith('@/')) base = `src/${clean.slice(2)}`;
  else if (clean.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), clean));
  else return null;
  const candidates = [base];
  const js = base.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
  if (js) candidates.push(...{ js: ['.ts', '.tsx'], jsx: ['.tsx'], mjs: ['.mts'], cjs: ['.cts'] }[js[2]].map((ext) => js[1] + ext));
  for (const ext of RESOLVE_EXT) candidates.push(base + ext);
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.jsx']) candidates.push(`${base}/index${ext}`);
  return candidates.find((file) => has(file)) ?? null;
}

/**
 * Hrany jednoho souboru: cílové soubory, plus prefixy šablonových importů.
 * Řádky komentářů (`//`, `*`, `/*` na začátku) se přeskočí – dokumentace tu
 * cituje cesty starého produktu a citace není import.
 */
function edgesOf(file, source, has, files) {
  const text = source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
  const targets = new Set();
  for (const pattern of SPEC_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const target = resolve(file, match[1], has);
      if (target) targets.add(target);
    }
  for (const match of text.matchAll(TEMPLATE_IMPORT)) {
    const prefix = match[1];
    const dir = prefix.startsWith('@/') ? `src/${prefix.slice(2)}` : prefix.startsWith('.') ? posix.join(posix.dirname(file), prefix) : null;
    if (!dir) continue;
    const norm = posix.normalize(dir);
    for (const candidate of files) if (candidate.startsWith(norm) && candidate !== file) targets.add(candidate);
  }
  for (const match of text.matchAll(REPO_PATH)) if (has(match[1])) targets.add(match[1]);
  const companion = file.replace(/\.mjs$/, '.d.mts');
  if (companion !== file && has(companion)) targets.add(companion);
  return targets;
}

function buildGraph(root, files, has) {
  const graph = new Map();
  for (const file of files) {
    if (!CODE.test(file) || file.endsWith('.json') || file.endsWith('.jsonl')) {
      graph.set(file, new Set());
      continue;
    }
    graph.set(file, edgesOf(file, readFileSync(join(root, file), 'utf8'), has, files));
  }
  return graph;
}

function entriesOf(root, files) {
  const globs = ENTRY_GLOBS.map(globToRegex);
  const commands = readCommands(root);
  const named = new Set();
  for (const match of commands.matchAll(/(?:^|[\s="'])(?:\.\/)?([\w.@-]+(?:\/[\w.@-]+)*\.(?:[cm]?[jt]s|tsx))(?=$|[\s"'])/gm)) named.add(match[1]);
  return files.filter((file) => !isTest(file) && (globs.some((glob) => glob.test(file)) || named.has(file)));
}

/**
 * @param {string} root
 * @param {{ exclude?: RegExp, files?: string[] }} [options]
 */
export function analyze(root, options = {}) {
  const all = (options.files ?? listFiles(root)).filter((file) => CODE.test(file) && (SCOPE.test(file) || !file.includes('/')));
  const files = options.exclude ? all.filter((file) => !options.exclude.test(file)) : all;
  const set = new Set(files);
  const has = (file) => set.has(file);
  const graph = buildGraph(root, files, has);
  const entries = entriesOf(root, files);

  const parent = new Map(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const target of graph.get(file) ?? [])
      if (!parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
  }
  const reachable = new Set(parent.keys());

  const tests = { kept: [], deletable: [], mixed: [] };
  const supportUsed = new Set();
  for (const test of files.filter((file) => isTestFile(file) && !reachable.has(file)).sort()) {
    // Co test zkouší: nejbližší netestové soubory, k nimž vede přes testovou podporu.
    const subjects = new Set();
    const seen = new Set([test]);
    const stack = [test];
    while (stack.length > 0)
      for (const target of graph.get(stack.pop()) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (isTest(target)) {
          stack.push(target);
          if (!isTestFile(target)) supportUsed.add(target);
        } else subjects.add(target);
      }
    const live = [...subjects].filter((file) => reachable.has(file)).length;
    if (live === subjects.size) tests.kept.push(test);
    else if (live === 0) tests.deletable.push(test);
    else tests.mixed.push(test);
  }
  // Podpora (fixtura, falešný proces) zůstává, dokud ji používá test, který zůstává.
  const supportKeptBy = new Set();
  for (const test of [...tests.kept, ...tests.mixed]) {
    const stack = [test];
    const seen = new Set(stack);
    while (stack.length > 0)
      for (const target of graph.get(stack.pop()) ?? [])
        if (isTest(target) && !seen.has(target)) {
          seen.add(target);
          supportKeptBy.add(target);
          stack.push(target);
        }
  }
  const supportFiles = files.filter((file) => isTest(file) && !isTestFile(file) && !reachable.has(file)).sort();
  const support = {
    kept: supportFiles.filter((file) => supportKeptBy.has(file) || !supportUsed.has(file)),
    deletable: supportFiles.filter((file) => supportUsed.has(file) && !supportKeptBy.has(file)),
  };

  const deletable = files.filter((file) => !isTest(file) && !reachable.has(file)).sort();
  return { files, entries, reachable, parent, deletable, tests, support };
}

/** Cesta importů od vstupního bodu k souboru, nebo `null`, když na něj nikdo nedosáhne. */
export function why(result, file) {
  if (!result.parent.has(file)) return null;
  const chain = [];
  for (let at = file; at !== null; at = result.parent.get(at)) chain.unshift(at);
  return chain;
}

/**
 * Po smazání: chybí vstupní bod, nebo ponechaný soubor importuje smazaný?
 * @param {string} root
 * @param {{ deleted: string[], exclude?: RegExp }} options
 */
export function check(root, options) {
  const deleted = new Set(options.deleted);
  const present = listFiles(root).filter((file) => CODE.test(file) && !deleted.has(file) && !options.exclude?.test(file));
  const known = new Set([...present, ...deleted]);
  const problems = [];
  const entries = new Set(entriesOf(root, [...known]));
  for (const file of [...deleted].sort()) if (entries.has(file)) problems.push(`${file} is an entry point`);
  const graph = buildGraph(root, present, (file) => known.has(file));
  for (const file of [...present].sort())
    for (const target of [...graph.get(file)].sort()) if (deleted.has(target)) problems.push(`${file} imports deleted ${target}`);
  return { problems };
}

/** Skupina pro přehled: druhá úroveň, pod `src/app`, `src/app/api` a `src/components` o úroveň hlouběji. */
function groupOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return '(root)';
  const depth = file.startsWith('src/app/api/') ? 4 : file.startsWith('src/app/') || file.startsWith('src/components/') ? 3 : 2;
  return parts.length > depth ? parts.slice(0, depth).join('/') : posix.dirname(file);
}

function report(result) {
  const rows = new Map();
  const row = (file) => {
    const key = groupOf(file);
    if (!rows.has(key)) rows.set(key, { reachable: 0, deletable: 0, testsKept: 0, testsDeletable: 0, testsMixed: 0 });
    return rows.get(key);
  };
  for (const file of result.files) {
    if (isTest(file)) continue;
    if (result.reachable.has(file)) row(file).reachable += 1;
    else row(file).deletable += 1;
  }
  for (const file of result.tests.kept) row(file).testsKept += 1;
  for (const file of [...result.tests.deletable, ...result.support.deletable]) row(file).testsDeletable += 1;
  for (const file of result.tests.mixed) row(file).testsMixed += 1;
  const lines = ['group\treachable\tdeletable\ttests-kept\ttests-deletable\ttests-mixed'];
  const total = { reachable: 0, deletable: 0, testsKept: 0, testsDeletable: 0, testsMixed: 0 };
  for (const [key, value] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push([key, value.reachable, value.deletable, value.testsKept, value.testsDeletable, value.testsMixed].join('\t'));
    for (const field of Object.keys(total)) total[field] += value[field];
  }
  lines.push(['TOTAL', total.reachable, total.deletable, total.testsKept, total.testsDeletable, total.testsMixed].join('\t'));
  return lines.join('\n');
}

function argValues(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const values = [];
  for (const value of process.argv.slice(index + 1)) {
    if (value.startsWith('--')) break;
    values.push(value.replace(/\\/g, '/').replace(/\/$/, ''));
  }
  return values;
}

const under = (dirs) => (file) => dirs.length === 0 || dirs.some((dir) => file === dir || file.startsWith(`${dir}/`));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const excludeArg = argValues('--exclude')?.[0];
  const exclude = excludeArg ? new RegExp(excludeArg) : undefined;
  if (argValues('--check')) {
    const dirs = argValues('--check');
    const head = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
    const deleted = head.filter((file) => file && CODE.test(file) && under(dirs)(file) && !existsSync(join(root, file)));
    const { problems } = check(root, { deleted, exclude });
    console.log(`deleted under ${dirs.join(' ') || '(all)'}: ${deleted.length}`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    process.exit(problems.length > 0 ? 1 : 0);
  }
  const result = analyze(root, { exclude });
  if (argValues('--why')) {
    const file = argValues('--why')[0];
    const chain = why(result, file);
    console.log(chain ? chain.join('\n  → ') : `${file}: unreachable from every entry point`);
  } else if (argValues('--list')) {
    const keep = under(argValues('--list'));
    for (const file of [...result.deletable, ...result.tests.deletable, ...result.support.deletable].filter(keep).sort()) console.log(file);
    for (const file of result.tests.mixed.filter(keep)) console.log(`${file}\t(mixed: tests reachable and unreachable code)`);
  } else {
    console.log(report(result));
    console.log(`entries: ${result.entries.length}`);
  }
}
