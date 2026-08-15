#!/usr/bin/env node
/**
 * Důkaz architektonické nezávislosti fallbacku (P2 T204).
 *
 * Tvrzení, které se dokazuje: **fallback se dá postavit a spustit ve stromu,
 * kde jádro neexistuje.** Grep importů to nedokáže — nepřímou závislost přes
 * třetí modul neuvidí, a přitom by fallback stáhla ke dnu spolu s jádrem.
 * Jediný důkaz, kterému se dá věřit, je artefakt sestavený bez jádra.
 *
 * Sekvence je **jedna nedělitelná úloha** a běží přesně v tomhle pořadí:
 *   1. spočítat tranzitivní obal jádra a odstavit ho z pracovního stromu;
 *   2. smazat `.next/`, `node_modules/.cache/` a předchozí artefakty;
 *   3. studený produkční build;
 *   4. spustit **ten vzniklý artefakt** na volném portu, s TCP spojením mimo
 *      loopback tvrdě zablokovaným;
 *   5. smoke test proti tomu procesu;
 *   6. vrátit odstavené soubory zpět.
 * Selže-li kterýkoli krok, selže celá úloha. Rozdělit ji na „build prošel" a
 * „smoke prošel" zvlášť by tvrdilo míň, než se tady tvrdit má.
 *
 * **Co se odstavuje, se počítá, ne píše.** Ručně psaný seznam by šel doplnit o
 * cokoliv, co zrovna překáží — včetně kusu fallbacku. Odstaví se proto přesně
 * tranzitivní obal čtyř adresářů jádra, a pokud by do něj spadl `src/fallback/`
 * nebo `src/kit/`, skript skončí dřív, než cokoliv přesune.
 *
 * Spuštění: `npm run prove:fallback`
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CORE_DIRS = ['src/sim', 'src/ir', 'src/verify', 'src/patch'];

/**
 * Adresáře, které do obalu jádra spadnout NESMÍ — to je celé tvrzení úlohy.
 * Routa `src/app/fallback/` je součástí fallbacku, ne jeho konzumentem, takže
 * platí i pro ni.
 */
export const PROTECTED_DIRS = ['src/fallback', 'src/kit', 'src/app/fallback'];

/** Routa, kterou musí izolovaný artefakt servírovat. Bez ní by byl důkaz vakuózní. */
export const FALLBACK_ROUTE = '/fallback/play';

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.isolation-quarantine',
  'out',
  'coverage',
  'playwright-report',
  'test-results',
]);

const SOURCE_EXT = ['.ts', '.tsx', '.mts'];

const QUARANTINE_DIR = '.isolation-quarantine';

const BASELINE_FILE = 'ops/fallback-chunk-baseline.json';

/** Prompty, jejichž routování ověřuje smoke. Verdikt počítá server, ne test. */
export const SMOKE_CASES = [
  {
    prompt: 'collect three keys and reach the gate before the timer runs out',
    kind: 'archetype',
    who: 'collect_unlock',
    layout: 'thicket-clearing',
  },
  {
    prompt: 'sort the coloured blocks into the right bins by dragging them',
    kind: 'archetype',
    who: 'sort_match',
    layout: 'foundry-hall',
  },
  {
    prompt: 'guide the wandering robot through the maze and steer it around the enemy path',
    kind: 'archetype',
    who: 'guide_avoid',
    layout: 'frost-plateau',
  },
  {
    prompt: 'a bouncing marble rolls down ramps with physics and gravity, momentum matters',
    kind: 'no_fit',
    who: 'collect_unlock',
    layout: 'thicket-clearing',
  },
];

// ---------------------------------------------------------------------------
// Import graf
// ---------------------------------------------------------------------------

const FROM_SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Specifikátory ze zdrojáku. Bere `import`, `export ... from` i dynamický
 * `import()`; `import type` je pro tenhle účel plnohodnotný import, protože
 * chybějící soubor rozbije typovou kontrolu úplně stejně jako chybějící hodnotu.
 */
export function importSpecifiers(source) {
  const found = new Set();
  for (const pattern of [FROM_SPECIFIER, BARE_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      found.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...found];
}

/**
 * Specifikátor → cesta v repozitáři, nebo `null` pro balíček z `node_modules`.
 * `universe` je množina skutečně existujících cest, takže se nehádá.
 */
export function resolveSpecifier(fromFile, specifier, universe) {
  let base;
  if (specifier.startsWith('@/')) {
    base = posix.join('src', specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  } else {
    return null;
  }

  const candidates = [base, ...SOURCE_EXT.map((ext) => base + ext), `${base}.json`];
  for (const ext of SOURCE_EXT) {
    candidates.push(posix.join(base, `index${ext}`));
  }

  return candidates.find((candidate) => universe.has(candidate)) ?? null;
}

/** Soubor → seznam souborů repozitáře, na které importem sahá. */
export function buildImportGraph(sourceFiles, universe, read) {
  const graph = new Map();
  for (const file of sourceFiles) {
    const edges = importSpecifiers(read(file))
      .map((specifier) => resolveSpecifier(file, specifier, universe))
      .filter((target) => target !== null);
    graph.set(file, [...new Set(edges)]);
  }
  return graph;
}

/** Je cesta uvnitř některého z adresářů? */
export function isUnder(path, dirs) {
  return dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/**
 * Tranzitivní obal jádra: semínko jsou soubory jádra, přidává se všechno, co na
 * něj přes libovolný počet kroků sahá. Fixpoint, ne jeden průchod — právě ta
 * nepřímá závislost je důvod, proč grep nestačí.
 */
export function coreReachSet(graph, seed) {
  const reached = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, edges] of graph) {
      if (reached.has(file)) continue;
      if (edges.some((target) => reached.has(target))) {
        reached.add(file);
        grew = true;
      }
    }
  }
  return reached;
}

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * Jména, která soubor přidává do globálního prostoru přes `declare global`.
 *
 * **Tohle je závislost, kterou import graf nevidí** a naměřilo se to tvrdě:
 * `e2e/smoke.spec.ts` neimportuje z jádra nic, ale sahá na `window.__worldsmith`,
 * který deklaruje `src/components/Stage.tsx`. Po odstavení jádra se ta deklarace
 * ztratí a typová kontrola buildu spadne na souboru, který v obalu nebyl.
 *
 * Bere se jen první úroveň členů augmentovaného rozhraní. Hlouběji jsou tvary
 * jako `renderer: string`, a kdyby se braly, odstavilo by se všechno, co to
 * slovo někde napíše.
 */
export function globalMembers(source) {
  const start = source.indexOf('declare global');
  if (start < 0) return [];
  const open = source.indexOf('{', start);
  if (open < 0) return [];

  let depth = 0;
  let flat = '';
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') {
      depth += 1;
      flat += char;
    } else if (char === '}') {
      depth -= 1;
      flat += char;
      if (depth === 0) break;
    } else {
      flat += depth <= 2 ? char : ' ';
    }
  }

  const cleaned = flat.replace(COMMENTS, ' ');
  const names = new Set();
  const member = /(\w+)\s*\??\s*:/g;
  let match = member.exec(cleaned);
  while (match !== null) {
    names.add(match[1]);
    match = member.exec(cleaned);
  }
  return [...names];
}

/**
 * Rozšíří obal o soubory, které na odstavené jméno sahají globálně. Fixpoint,
 * protože přidaný soubor může sám deklarovat další globál.
 */
export function expandByAmbientGlobals(reach, sourceFiles, read) {
  const expanded = new Set(reach);
  const claimed = new Set();
  let grew = true;

  while (grew) {
    grew = false;
    const names = new Set();
    for (const file of expanded) {
      if (claimed.has(file) || !SOURCE_EXT.some((ext) => file.endsWith(ext))) continue;
      claimed.add(file);
      for (const name of globalMembers(read(file))) names.add(name);
    }
    if (names.size === 0) break;

    const pattern = new RegExp(`\\b(${[...names].join('|')})\\b`);
    for (const file of sourceFiles) {
      if (expanded.has(file)) continue;
      if (pattern.test(read(file))) {
        expanded.add(file);
        grew = true;
      }
    }
  }

  return expanded;
}

// ---------------------------------------------------------------------------
// Analýza bundlu
// ---------------------------------------------------------------------------

const CONCAT_MARKER = '(concatenated)/';

/**
 * Skutečná cesta modulu z cesty, kterou vypsal analyzer.
 *
 * Webpack při scope hoistingu slepí moduly do jednoho a vypíše je pod cestou
 * `./src/kit/index.ts + 17 modules (concatenated)/src/ir/worlddoc.ts`.
 * **Bez tohohle by modul jádra schovaný uvnitř slepence prošel** — prefix je
 * cesta fallbacku, takže kontrola na jádro se dívá na špatný konec řetězce.
 */
export function moduleTail(path) {
  const at = path.lastIndexOf(CONCAT_MARKER);
  return at < 0 ? path : path.slice(at + CONCAT_MARKER.length);
}

/**
 * Listy stromu z `webpack-bundle-analyzer` v režimu `json`. Uzel bez `groups`
 * je skutečný modul v chunku — tohle je ten „skutečný bundle", o kterém mluví AC.
 *
 * Modul ve dvou chuncích se počítá dvakrát, protože se dvakrát i stahuje;
 * baseline měří bajty v artefaktu, ne počet různých souborů.
 *
 * Měří se `statSize`, tedy zdrojové bajty tak, jak je viděl webpack.
 * `parsedSize` je u slepených modulů **nula**, ne `undefined`, takže by se
 * naměřilo skoro nic a vypadalo by to jako výsledek. Naměřeno: serverový report
 * s ním dal 1 196 B místo 214 769 B.
 */
export function analyzerModules(report) {
  const modules = [];
  const walk = (node, chunk) => {
    if (Array.isArray(node.groups)) {
      for (const child of node.groups) walk(child, chunk);
      return;
    }
    if (typeof node.path !== 'string') return;
    modules.push({
      chunk,
      path: moduleTail(node.path.replace(/\\/g, '/').replace(/^\.\//, '')),
      statBytes: node.statSize ?? 0,
    });
  };
  for (const asset of report) {
    walk(asset, asset.label ?? '<asset>');
  }
  return modules;
}

/** Moduly jádra v bundlu. Neprázdný výsledek je selhání celé úlohy. */
export function coreModulesIn(modules) {
  return modules.filter((module) => isUnder(module.path, CORE_DIRS));
}

/** Bajty fallbacku a kitu v bundlu — měřená veličina, která jde do baseline. */
export function fallbackBytes(modules) {
  const own = modules.filter((module) => isUnder(module.path, PROTECTED_DIRS));
  return {
    moduleCount: own.length,
    statBytes: own.reduce((sum, module) => sum + module.statBytes, 0),
    totalStatBytes: modules.reduce((sum, module) => sum + module.statBytes, 0),
  };
}

// ---------------------------------------------------------------------------
// Prostředí podprocesů
// ---------------------------------------------------------------------------

const SECRET_LIKE = /(api[_-]?key|_key$|token|secret|password|credential|openai|anthropic|proxy)/i;

/**
 * Prostředí bez čehokoli, co vypadá jako přístup k vzdálenému API. Krok 4 chce
 * artefakt bez cesty ven; klíč v prostředí je první polovina takové cesty.
 */
export function scrubbedEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_LIKE.test(key)) out[key] = value;
  }
  out.NEXT_TELEMETRY_DISABLED = '1';
  return out;
}

/**
 * Druhá polovina: TCP mimo loopback se v běžícím artefaktu neotevře vůbec.
 * Guard se vkládá přes `--import`, takže platí i pro moduly, které si `net`
 * vytáhnou samy (`fetch` z undici mezi ně patří).
 */
const NETWORK_GUARD = `
import net from 'node:net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '']);
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
  const host = options.host ?? (typeof args[1] === 'string' ? args[1] : undefined);
  if (options.path === undefined && !LOOPBACK.has(String(host ?? '').toLowerCase())) {
    throw new Error('isolation guard: outbound connection to ' + host + ' is blocked');
  }
  return original.apply(this, args);
};
`;

// ---------------------------------------------------------------------------
// Sekvence
// ---------------------------------------------------------------------------

const ROOT = resolve(process.cwd());

function git(...args) {
  // `--no-replace-objects` jako pre-subcommand flag na každém volání: `git replace`
  // umí podstrčit jiné bajty pod nezměněné OID a stav pracovního stromu je tady
  // kontrola, ne kosmetika.
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
  }).trim();
}

/** Všechny soubory repozitáře kromě artefaktů. Relativní cesty, lomítka dopředu. */
export function listFiles(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir === '' ? '.' : dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}

function step(index, label) {
  process.stdout.write(`\n[${index}/6] ${label}\n`);
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function run(label, args, env) {
  const result = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  return new Promise((done, fail) => {
    result.on('error', fail);
    result.on('exit', (code) => {
      if (code === 0) done();
      else fail(new Error(`${label} skončil kódem ${code}`));
    });
  });
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server skončil dřív, než odpověděl (kód ${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${FALLBACK_ROUTE}`);
      if (response.status < 500) return;
    } catch {
      // ještě neposlouchá
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('server neodpověděl do 90 s');
}

/** Hodnota z `data-testid`. React mezi textové uzly vkládá komentáře, proto se odstraní. */
export function testId(html, id) {
  const match = html
    .replace(/<!--.*?-->/g, '')
    .match(new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`));
  return match === null ? null : match[1].trim();
}

async function smoke(port) {
  for (const expected of SMOKE_CASES) {
    const url = `http://127.0.0.1:${port}${FALLBACK_ROUTE}?prompt=${encodeURIComponent(expected.prompt)}`;
    const response = await fetch(url);
    if (response.status !== 200) {
      throw new Error(`${expected.prompt}: HTTP ${response.status}`);
    }
    const html = await response.text();
    for (const [id, want] of [
      ['route-kind', expected.kind],
      ['route-archetype', expected.who],
      ['route-layout', expected.layout],
    ]) {
      const got = testId(html, id);
      if (got !== want) {
        throw new Error(`${expected.prompt}: ${id} je "${got}", čekalo se "${want}"`);
      }
    }
    if ((testId(html, 'route-reason') ?? '') === '') {
      throw new Error(`${expected.prompt}: rozhodnutí nemá důvod`);
    }
    process.stdout.write(`      ✓ ${expected.kind} → ${expected.who}  (${expected.prompt})\n`);
  }
}

/**
 * `@next/bundle-analyzer` neskládá cestu reportu stejně pro klienta a pro
 * server — klientský končí v `.next/analyze/`, serverový podle výstupního
 * adresáře webpacku o dvě úrovně výš. Hledá se proto na obou místech.
 */
function readReport(name) {
  const file = [join(ROOT, '.next', 'analyze', `${name}.json`), join(ROOT, 'analyze', `${name}.json`)].find(
    (candidate) => existsSync(candidate),
  );
  if (file === undefined) {
    throw new Error(`chybí report ${name}.json — build neběžel s ANALYZE=true`);
  }
  return analyzerModules(JSON.parse(readFileSync(file, 'utf-8')));
}

function analyze() {
  const measured = {};
  for (const name of ['client', 'nodejs']) {
    const modules = readReport(name);
    const contaminated = coreModulesIn(modules);
    if (contaminated.length > 0) {
      const sample = contaminated.slice(0, 5).map((module) => `${module.chunk}: ${module.path}`);
      throw new Error(`bundle ${name} obsahuje moduly jádra:\n  ${sample.join('\n  ')}`);
    }
    measured[name] = fallbackBytes(modules);
    process.stdout.write(
      `      ${name}: fallback+kit ${measured[name].moduleCount} modulů, ` +
        `${measured[name].statBytes} B z ${measured[name].totalStatBytes} B celkem\n`,
    );
  }

  // Anti-vakuóznost: prázdný bundle by prošel kontrolou na jádro triviálně.
  const own = measured.client.moduleCount + measured.nodejs.moduleCount;
  if (own === 0) {
    throw new Error('v bundlu není ani jeden modul fallbacku — důkaz by byl vakuózní');
  }
  return measured;
}

async function main() {
  const before = git('status', '--porcelain');
  const quarantine = join(ROOT, QUARANTINE_DIR);
  if (existsSync(quarantine)) {
    throw new Error(
      `${QUARANTINE_DIR}/ zbyl po předchozím běhu — vrať jeho obsah zpět, než se pustíš znovu`,
    );
  }

  step(1, 'tranzitivní obal jádra a karanténa');
  const universe = new Set(listFiles(''));
  const sourceFiles = [...universe].filter((file) => SOURCE_EXT.some((ext) => file.endsWith(ext)));
  const graph = buildImportGraph(sourceFiles, universe, (file) =>
    readFileSync(join(ROOT, file), 'utf-8'),
  );
  const seed = [...universe].filter((file) => isUnder(file, CORE_DIRS));
  const reach = expandByAmbientGlobals(coreReachSet(graph, seed), sourceFiles, (file) =>
    readFileSync(join(ROOT, file), 'utf-8'),
  );

  const leaked = [...reach].filter((file) => isUnder(file, PROTECTED_DIRS));
  if (leaked.length > 0) {
    throw new Error(`fallback sahá na jádro:\n  ${leaked.join('\n  ')}`);
  }
  const routeFile = 'src/app/fallback/play/page.tsx';
  if (!universe.has(routeFile)) {
    throw new Error(`chybí ${routeFile} — bez routy nemá analýza bundlu co analyzovat`);
  }

  const moved = [...reach].sort();
  process.stdout.write(
    `      ${seed.length} souborů jádra + ${moved.length - seed.length} závislých = ${moved.length} odstaveno\n`,
  );
  for (const file of moved) {
    const target = join(quarantine, file);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(ROOT, file), target);
  }
  for (const dir of CORE_DIRS) {
    rmSync(join(ROOT, dir), { recursive: true, force: true });
  }

  let measured;
  try {
    step(2, 'smazat předchozí artefakty');
    for (const artefact of ['.next', 'out', 'analyze', join('node_modules', '.cache')]) {
      rmSync(join(ROOT, artefact), { recursive: true, force: true });
    }

    step(3, 'studený produkční build bez jádra');
    const buildEnv = { ...scrubbedEnv(process.env), ANALYZE: 'true', NODE_ENV: 'production' };
    await run('build', ['node_modules/next/dist/bin/next', 'build', '--webpack'], buildEnv);

    step(4, 'spustit ten artefakt bez cesty ven');
    const guardDir = mkdtempSync(join(tmpdir(), 'fallback-guard-'));
    const guardFile = join(guardDir, 'no-outbound.mjs');
    writeFileSync(guardFile, NETWORK_GUARD, 'utf-8');
    const port = await freePort();
    const server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: ROOT,
        env: {
          ...scrubbedEnv(process.env),
          NODE_ENV: 'production',
          NODE_OPTIONS: `--import ${pathToFileURL(guardFile).href}`,
        },
        stdio: 'inherit',
      },
    );

    try {
      await waitForServer(port, server);
      process.stdout.write(`      artefakt běží na 127.0.0.1:${port}\n`);

      step(5, 'smoke proti tomuhle procesu');
      await smoke(port);

      process.stdout.write('\n      analýza skutečného bundlu\n');
      measured = analyze();
    } finally {
      server.kill();
      rmSync(guardDir, { recursive: true, force: true });
    }
  } finally {
    step(6, 'vrátit odstavené soubory');
    for (const file of moved) {
      const target = join(ROOT, file);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(quarantine, file), target);
    }
    rmSync(quarantine, { recursive: true, force: true });
  }

  const after = git('status', '--porcelain');
  if (after !== before) {
    throw new Error(`pracovní strom se po obnově neshoduje se stavem před během:\n${after}`);
  }

  const baseline = {
    note:
      'Velikost fallbacku v izolovaném produkčním buildu, ve zdrojových bajtech ' +
      '(webpack statSize). Píše scripts/prove-fallback-isolation.mjs.',
    commit: git('rev-parse', 'HEAD'),
    client: measured.client,
    server: measured.nodejs,
  };
  const baselineFile = join(ROOT, BASELINE_FILE);
  const previous = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf-8')) : null;
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  if (previous !== null) {
    process.stdout.write(
      `\n      baseline: klient ${previous.client.statBytes} B → ${baseline.client.statBytes} B, ` +
        `server ${previous.server.statBytes} B → ${baseline.server.statBytes} B\n`,
    );
  }

  process.stdout.write(`\n✅ fallback se postavil, spustil a obsloužil ${SMOKE_CASES.length} promptů bez jádra\n`);
}

/**
 * Záchrana po tvrdém zabití procesu. Obnova v `finally` nepokryje `SIGKILL` ani
 * zavřený terminál, a odstavené soubory v `.isolation-quarantine/` jsou pak
 * jediná kopie — vrátit je musí jít jedním příkazem, ne ručně.
 */
function restoreQuarantine() {
  const quarantine = join(ROOT, QUARANTINE_DIR);
  if (!existsSync(quarantine)) {
    process.stdout.write('nic k obnově\n');
    return;
  }
  const files = listFiles(QUARANTINE_DIR).map((file) => file.slice(QUARANTINE_DIR.length + 1));
  for (const file of files) {
    mkdirSync(dirname(join(ROOT, file)), { recursive: true });
    renameSync(join(quarantine, file), join(ROOT, file));
  }
  rmSync(quarantine, { recursive: true, force: true });
  process.stdout.write(`obnoveno ${files.length} souborů\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const task = process.argv[2] === '--restore' ? async () => restoreQuarantine() : main;
  task().catch((error) => {
    process.stderr.write(`\n❌ ${error.message}\n`);
    process.exitCode = 1;
  });
}
