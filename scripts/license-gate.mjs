#!/usr/bin/env node
/**
 * Licenční brána: co je v produktu a pod jakou licencí to smíme mít.
 *
 * `RULES.md` §2 vyžaduje disclosure **každé knihovny, assetu, modelu a datasetu**
 * se zdrojem, autorem, licencí a povinnými notices — a repozitář půjde ven jako
 * veřejný. `RULES.md` §4 to má jako blokující kontrolu **před každým `npm install`**.
 * Ruční seznam by tu podmínku nepřežil šedesát dní, proto je registr strojový a
 * `DISCLOSURE.md` se z něj generuje.
 *
 * ## Dva režimy
 *
 *   node scripts/license-gate.mjs          ověří; exit 1 při jakémkoli nálezu
 *   node scripts/license-gate.mjs --sync   přegeneruje odvoditelné části registru
 *                                          a DISCLOSURE.md, pak ověří
 *
 * `--sync` sahá **jen na to, co jde odvodit ze stromu**: `library` z
 * `package-lock.json` a `asset` z `public/`. Položky `model`, `dataset` a `api`
 * se píšou ručně a sync je nechá být — ty totiž ze stromu odvodit nejdou a
 * automatika, která by si je domýšlela, by z registru udělala hádání.
 *
 * ## Proč brána selže i na prázdném poli
 *
 * `requiredNotices: []` u licence, která notice nevyžaduje, je nerozeznatelné od
 * „ještě jsme to nezjistili". Prázdné pole je proto selhání a správná odpověď je
 * napsat to slovy (`"žádné — 0BSD notice nevyžaduje"`). Registr tím říká, co
 * někdo ověřil, ne co nikdo nevyplnil.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const REGISTRY_FILE = 'disclosure.json';
const RENDERED_FILE = 'DISCLOSURE.md';
const LOCK_FILE = 'package-lock.json';

/** Pět tříd z AC. Registr nesmí nést nic jiného — neznámý `kind` je selhání, ne varování. */
const KINDS = ['library', 'asset', 'model', 'dataset', 'api'];

/** Odvoditelné ze stromu, takže je `--sync` přepisuje. Zbytek je ruční a nedotčený. */
const DERIVED_KINDS = ['library', 'asset'];

const REQUIRED_FIELDS = ['name', 'kind', 'source', 'authorOrProvider', 'license', 'requiredNotices', 'attribution'];

/**
 * Licence, které projdou samy. Permisivní, notice-only, žádný dopad na to, pod
 * čím smí být náš vlastní kód.
 */
const ALLOWED = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0', 'Unlicense']);

/**
 * Licence, které projdou **jen s dopsaným `reviewNote`**. Copyleft a licence s
 * povinnou atribucí nejsou zakázané, ale nesmějí projít tiše: u každé takové
 * položky musí v registru stát, proč je v tomhle produktu bezpečná.
 *
 * Konkrétně dnes: `@img/sharp-libvips-*` (LGPL) jsou nativní binárky image
 * optimizeru Next.js — běží na serveru, do prohlížečového bundlu nevstupují a
 * nejsou modifikované. `caniuse-lite` (CC-BY-4.0) je build-time dataset.
 * `lightningcss` (MPL-2.0) je dev závislost. Kdyby se kterákoli z těch vět
 * přestala týkat pravdy, `reviewNote` je místo, kde to bude vidět.
 */
const ALLOWED_WITH_NOTE = new Set(['LGPL-3.0-or-later', 'MPL-2.0', 'CC-BY-4.0', 'WTFPL']);

/**
 * Povinné notices podle licence. Není to právní rada, je to kontrolní seznam —
 * a je zapsaný tady, aby se u dvou balíčků se stejnou licencí nelišil podle toho,
 * kdo entry psal.
 */
const NOTICES = {
  MIT: ['copyright notice', 'plné znění licence'],
  ISC: ['copyright notice', 'plné znění licence'],
  'BSD-2-Clause': ['copyright notice', 'plné znění licence', 'disclaimer'],
  'BSD-3-Clause': ['copyright notice', 'plné znění licence', 'disclaimer', 'zákaz použití jména autora k propagaci'],
  '0BSD': ['žádné — 0BSD notice nevyžaduje'],
  'Apache-2.0': ['copyright notice', 'plné znění licence', 'soubor NOTICE, pokud balíček nějaký nese', 'označení změn'],
  'CC0-1.0': ['žádné — CC0 se vzdává i práva na atribuci'],
  Unlicense: ['žádné — Unlicense notice nevyžaduje'],
  'LGPL-3.0-or-later': [
    'copyright notice',
    'plné znění licence',
    'právo příjemce knihovnu nahradit nebo přelinkovat',
    'dostupnost zdrojů knihovny',
  ],
  'MPL-2.0': ['plné znění licence', 'zdroje modifikovaných souborů, pokud se modifikují'],
  'CC-BY-4.0': ['atribuce autora', 'odkaz na licenci', 'označení změn'],
  WTFPL: ['žádné — WTFPL notice nevyžaduje'],
};

/**
 * Hostitelé, kteří nejsou externí služba, takže do registru `api` nepatří.
 * Loopback plus jmenné prostory vyhrazené RFC 2606 a RFC 6761 pro dokumentaci
 * a testy — ty se z definice nedají zavolat na nic skutečného.
 */
const NOT_EXTERNAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|example\.(com|net|org)|.+\.(test|invalid|localhost|example))$/i;

/** Kde se hledají volané endpointy. Testy ne — ty volají fixtury, ne službu. */
const CODE_ROOTS = ['src', 'evals', 'scripts'];
const CODE_SKIP_DIR = /^(node_modules|\.next|__tests__|__snapshots__|live)$/;
const CODE_FILE = /\.(ts|tsx|mjs|js)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;

// ---------------------------------------------------------------------------
// Čtení stromu
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(join(REPO, path), 'utf8'));
}

function loadRegistry() {
  if (!existsSync(join(REPO, REGISTRY_FILE))) return { error: `${REGISTRY_FILE} chybí — spusť \`--sync\`` };
  try {
    const parsed = readJson(REGISTRY_FILE);
    if (!Array.isArray(parsed.entries)) return { error: `${REGISTRY_FILE} nemá pole "entries"` };
    return { entries: parsed.entries };
  } catch (error) {
    return { error: `${REGISTRY_FILE} se nedá přečíst: ${error.message}` };
  }
}

/**
 * Balíčky z lockfilu. Klíčem je **celá cesta** (`node_modules/a/node_modules/b`),
 * ne holé jméno: tentýž balíček ve dvou verzích jsou dvě různé licenční položky
 * a slitím do jednoho jména by jedna z nich z registru zmizela.
 */
function lockPackages() {
  const lock = readJson(LOCK_FILE);
  const out = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || meta.link) continue;
    out.push({
      path,
      name: path.replace(/^node_modules\//, '').replace(/\/node_modules\//g, ' › '),
      version: meta.version ?? '',
      license: Array.isArray(meta.license) ? meta.license.join(' AND ') : meta.license,
      resolved: meta.resolved ?? '',
      dev: Boolean(meta.dev),
    });
  }
  return out;
}

function listAssets() {
  const root = join(REPO, 'public');
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(REPO, full).split(sep).join(posix.sep));
    }
  };
  walk(root);
  return out;
}

/**
 * Odstraní komentáře, řetězce nechá. Rozhoduje to o tom, co je *volaný* endpoint:
 * URL v dokumentačním komentáři nikdo nezavolá, URL v řetězci ano. Regulárním
 * výrazem to nejde — `'http://x' // pozn.` má obojí na jednom řádku a naivní
 * `//` matcher by uřízl půlku řetězce.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Identifikátory modelů v kódu. **Je to lexikální shoda proti tvaru jména**, ne
 * seznam poskytovatelů — stejně skromné tvrzení jako u `cleanroom-check`. Model
 * vyskládaný za běhu z proměnných tahle kontrola nevidí.
 *
 * Existuje proto, že `RULES.md` §2 vyžaduje disclosure **modelů**, a bez ní byla
 * třída `model` prázdná a nefalzifikovatelná: registr hlásil „disclosure je
 * úplná", zatímco kód jmenoval pět modelů, o kterých v něm nestálo nic.
 */
export function modelIdsIn(source) {
  const found = new Set();
  for (const match of stripComments(source).matchAll(/\b(?:gpt|claude|gemini|llama|mistral|deepseek)-[a-z0-9][-a-z0-9.]*/gi)) {
    found.add(match[0].toLowerCase().replace(/[.\-]+$/, ''));
  }
  return found;
}

export function hostsIn(source) {
  const found = new Set();
  for (const match of stripComments(source).matchAll(/https?:\/\/([A-Za-z0-9.\-]+)/g)) {
    const host = match[1];
    if (!NOT_EXTERNAL.test(host)) found.add(host.toLowerCase());
  }
  return found;
}

/** Projde produkční kód a sesbírá, co v něm `extract` najde: host → první soubor. */
function scanCode(extract) {
  const hits = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CODE_SKIP_DIR.test(entry.name)) walk(full);
        continue;
      }
      if (!CODE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
      const shown = relative(REPO, full).split(sep).join(posix.sep);
      for (const value of extract(readFileSync(full, 'utf8'))) {
        if (!hits.has(value)) hits.set(value, shown);
      }
    }
  };
  for (const root of CODE_ROOTS) walk(join(REPO, root));
  return hits;
}

const calledHosts = () => scanCode(hostsIn);
const namedModels = () => scanCode(modelIdsIn);

// ---------------------------------------------------------------------------
// Odvození položek pro `--sync`
// ---------------------------------------------------------------------------

function packageAuthor(path) {
  const manifest = join(REPO, path, 'package.json');
  if (!existsSync(manifest)) return '';
  try {
    const { author } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof author === 'string') return author.replace(/\s*<[^>]*>/g, '').trim();
    if (author && typeof author.name === 'string') return author.name.trim();
  } catch {
    return '';
  }
  return '';
}

function packageCopyright(path) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md']) {
    const file = join(REPO, path, name);
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /copyright/i.test(l) && l.length > 10);
    if (line) return line.slice(0, 200);
  }
  return '';
}

function noticesFor(license) {
  if (NOTICES[license]) return NOTICES[license];
  // Složená licence (`Apache-2.0 AND LGPL-3.0-or-later`) nese notices všech částí.
  const parts = license.split(/\s+(?:AND|OR)\s+/).map((p) => p.replace(/[()]/g, '').trim());
  const merged = [];
  for (const part of parts) for (const notice of NOTICES[part] ?? []) if (!merged.includes(notice)) merged.push(notice);
  return merged;
}

function deriveLibraries() {
  return lockPackages().map((pkg) => {
    const author = packageAuthor(pkg.path);
    const copyright = packageCopyright(pkg.path);
    return {
      name: `${pkg.name}@${pkg.version}`,
      kind: 'library',
      source: pkg.resolved || `https://registry.npmjs.org/${pkg.name}`,
      // Prázdné pole by bránu shodilo, takže se sem nesmí dostat "". Když balíček
      // autora nedeklaruje, je pravdivá odpověď právě tahle věta — a v
      // DISCLOSURE.md se takové položky vypisují zvlášť, aby nezapadly.
      authorOrProvider: author || 'neuvedeno upstreamem',
      license: pkg.license || '',
      requiredNotices: noticesFor(pkg.license || ''),
      attribution: copyright || `držitelé práv k ${pkg.name}, viz ${pkg.resolved || 'npm'}`,
      scope: pkg.dev ? 'dev' : 'prod',
    };
  });
}

function deriveAssets() {
  return listAssets().map((path) => ({
    name: path,
    kind: 'asset',
    source: 'vlastní tvorba v tomhle repozitáři',
    authorOrProvider: 'worldsmith',
    license: 'MIT',
    requiredNotices: NOTICES.MIT,
    attribution: 'worldsmith, tenhle repozitář',
  }));
}

// ---------------------------------------------------------------------------
// Vykreslení DISCLOSURE.md
// ---------------------------------------------------------------------------

const KIND_TITLES = {
  library: 'Knihovny',
  asset: 'Assety',
  model: 'Modely',
  dataset: 'Datasety',
  api: 'Externí služby',
};

function cell(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value);
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderDisclosure(entries) {
  const lines = [
    '# Disclosure',
    '',
    '<!-- GENEROVÁNO: `node scripts/license-gate.mjs --sync`. Needituj ručně —',
    '     zdrojem pravdy je `disclosure.json`, tenhle soubor je jeho výpis. -->',
    '',
    'Seznam všeho, co projekt používá a nenapsal si sám, podle `RULES.md` §2:',
    'zdroj, autor nebo poskytovatel, licence a povinné notices.',
    '',
  ];

  for (const kind of KINDS) {
    const group = entries.filter((entry) => entry.kind === kind);
    lines.push(`## ${KIND_TITLES[kind]} (${group.length})`, '');
    if (group.length === 0) {
      lines.push('_Žádná položka._', '');
      continue;
    }
    lines.push(
      '| Název | Zdroj | Autor / poskytovatel | Licence | Povinné notices | Atribuce |',
      '|---|---|---|---|---|---|',
    );
    for (const entry of group) {
      lines.push(
        `| ${cell(entry.name)} | ${cell(entry.source)} | ${cell(entry.authorOrProvider)} | ` +
          `${cell(entry.license)} | ${cell(entry.requiredNotices)} | ${cell(entry.attribution)} |`,
      );
    }
    lines.push('');

    const reviewed = group.filter((entry) => entry.reviewNote);
    if (reviewed.length > 0) {
      lines.push(`### ${KIND_TITLES[kind]} — licence posouzené jednotlivě`, '');
      for (const entry of reviewed) lines.push(`- **${entry.name}** (${entry.license}): ${entry.reviewNote}`);
      lines.push('');
    }

    const unnamed = group.filter((entry) => entry.authorOrProvider === 'neuvedeno upstreamem');
    if (unnamed.length > 0) {
      lines.push(
        `### ${KIND_TITLES[kind]} — bez deklarovaného autora (${unnamed.length})`,
        '',
        'Tyhle balíčky autora ve svém `package.json` neuvádějí. Atribuce se proto opírá',
        'o copyright řádek z jejich LICENSE souboru, ne o jméno v metadatech.',
        '',
      );
      for (const entry of unnamed) lines.push(`- ${entry.name}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Kontroly
// ---------------------------------------------------------------------------

const checks = [];
const check = (id, title, run) => checks.push({ id, title, run });

/**
 * Registr má 170 položek, takže hlásit jen první nález znamená, že se druhá vada
 * ukáže až po opravě první — a u brány, která běží v `pre-commit`, je to jedno
 * kolo navíc za každou z nich. Tři jsou kompromis: dost na to, aby šlo opravit
 * víc věcí najednou, málo na to, aby výpis zůstal čitelný.
 */
function summarize(problems) {
  if (problems.length === 0) return null;
  const shown = problems.slice(0, 3).join('\n        ');
  const rest = problems.length > 3 ? `\n        … a dalších ${problems.length - 3}` : '';
  return `${problems.length} nálezů:\n        ${shown}${rest}`;
}

check(1, 'registr má tvar a žádné pole není prázdné', ({ registry }) => {
  if (registry.error) return registry.error;
  const problems = [];
  const seen = new Set();
  for (const entry of registry.entries) {
    const label = entry?.name ? `${entry.kind ?? '?'}/${entry.name}` : JSON.stringify(entry).slice(0, 60);
    if (!KINDS.includes(entry?.kind)) problems.push(`${label}: kind "${entry?.kind}" není jedna z ${KINDS.join(', ')}`);
    for (const field of REQUIRED_FIELDS) {
      const value = entry?.[field];
      const empty =
        value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && (value.length === 0 || value.every((item) => String(item).trim() === '')));
      if (empty) problems.push(`${label}: pole "${field}" chybí nebo je prázdné`);
    }
    const key = `${entry?.kind}/${entry?.name}`;
    if (seen.has(key)) problems.push(`${label}: položka je v registru dvakrát`);
    seen.add(key);
  }
  return summarize(problems);
});

/**
 * SPDX whitelist platí na to, co **redistribuujeme** — `library` a `asset`. Tam
 * je otázka „nesahá ta licence na licenci našeho kódu".
 *
 * `model`, `dataset` a `api` se neredistribuují, jejich podmínky nejsou SPDX
 * identifikátor a měřit je stejnou stupnicí by znamenalo buď je odmítat všechny,
 * nebo whitelist rozšířit o volný text — a tím ho zrušit. Platí pro ně proto
 * **přísnější** pravidlo, ne volnější: licence nesmí být prázdná **a `reviewNote`
 * je povinný vždycky**. Podmínky služby je prózou, kterou musel někdo přečíst;
 * tohle je místo, kde je napsané, že ji přečetl.
 */
const REDISTRIBUTED_KINDS = new Set(['library', 'asset']);

check(2, 'každá licence je na whitelistu nebo má zapsané posouzení', ({ registry }) => {
  if (registry.error) return registry.error;
  const problems = [];
  for (const entry of registry.entries) {
    const license = String(entry?.license ?? '').trim();
    if (!license) {
      problems.push(`${entry?.name}: licence není deklarovaná`);
      continue;
    }
    if (!REDISTRIBUTED_KINDS.has(entry?.kind)) {
      if (!String(entry?.reviewNote ?? '').trim()) {
        problems.push(`${entry?.name}: kind "${entry?.kind}" se neredistribuuje, ale "reviewNote" je u něj povinný`);
      }
      continue;
    }
    const parts = license
      .split(/\s+(?:AND|OR)\s+/)
      .map((part) => part.replace(/[()]/g, '').trim())
      .filter(Boolean);
    const unknown = parts.filter((part) => !ALLOWED.has(part) && !ALLOWED_WITH_NOTE.has(part));
    if (unknown.length > 0) {
      problems.push(`${entry?.name}: licence "${unknown.join(', ')}" není na whitelistu`);
      continue;
    }
    const needsNote = parts.some((part) => ALLOWED_WITH_NOTE.has(part));
    if (needsNote && !String(entry?.reviewNote ?? '').trim()) {
      problems.push(`${entry?.name}: licence "${license}" projde jen s vyplněným "reviewNote"`);
    }
  }
  return summarize(problems);
});

check(3, 'registr sedí na package-lock.json v obou směrech', ({ registry }) => {
  if (registry.error) return registry.error;
  const expected = new Set(deriveLibraries().map((entry) => entry.name));
  const actual = new Set(registry.entries.filter((entry) => entry.kind === 'library').map((entry) => entry.name));
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length) return `${missing.length} závislostí není v registru, první: ${missing[0]} (spusť --sync)`;
  if (extra.length) return `${extra.length} položek registru už není v lockfilu, první: ${extra[0]} (spusť --sync)`;
  return null;
});

check(4, 'registr sedí na public/ v obou směrech', ({ registry }) => {
  if (registry.error) return registry.error;
  const expected = new Set(listAssets());
  const actual = new Set(registry.entries.filter((entry) => entry.kind === 'asset').map((entry) => entry.name));
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length) return `${missing.length} assetů není v registru, první: ${missing[0]} (spusť --sync)`;
  if (extra.length) return `${extra.length} položek registru už v public/ není, první: ${extra[0]} (spusť --sync)`;
  return null;
});

/**
 * **Co tahle kontrola měří: URL v řetězcích mimo komentáře.** Ne prokázaná volání
 * — na to by bylo potřeba sledovat tok dat do `fetch`, a to tenhle skript nedělá
 * a nepředstírá. Následek je, že se sem dostane i host, který je v řetězci a
 * nikdo ho nezavolá; správná odpověď je ho do registru zapsat, ne kontrolu
 * změkčit. Disclosure podle `RULES.md` §2 se stejně ptá „na čem to stojí", ne
 * „co se zavolalo za běhu".
 *
 * Opačný směr je horší a je dobré ho znát: **host složený za běhu**
 * (`\`https://${provider}.example/\``) tahle kontrola nevidí vůbec.
 */
check(5, 'každý volaný endpoint má v registru položku kind: api', ({ registry }) => {
  if (registry.error) return registry.error;
  // Host se porovnává jako celý host z rozparsované URL, ne podřetězcem.
  // Podřetězcové porovnání propouštělo `pi.openai.com` proti registrovanému
  // `https://api.openai.com/...`, protože je to jeho podřetězec — tedy přesně
  // exfiltrační host, který vypadá jako disclosovaný.
  const known = new Set();
  for (const entry of registry.entries) {
    if (entry.kind !== 'api') continue;
    const source = String(entry.source ?? '').trim();
    try {
      known.add(new URL(source).host.toLowerCase());
    } catch {
      // Zdroj, který není URL, se bere jako holý host — jinak by položka mlčky
      // nekryla nic a kontrola by hlásila host, který v registru je.
      known.add(source.toLowerCase());
    }
  }
  const unknown = [];
  for (const [host, file] of calledHosts()) {
    if (!known.has(host)) unknown.push(`${host} (${file})`);
  }
  // Každý neznámý host potřebuje vlastní ruční položku, takže první nález nestačí.
  return summarize(unknown);
});

/**
 * Bez téhle kontroly byla třída `model` prázdná a nikdo se to nedozvěděl:
 * `RULES.md` §2 disclosure modelů vyžaduje, kód jich jmenoval pět a registr
 * hlásil úplnost. Prázdná povinná třída, kterou nic nefalzifikuje, je horší než
 * chybějící položka — vypadá jako splněná.
 */
check(7, 'každý model jmenovaný v kódu má v registru položku kind: model', ({ registry }) => {
  if (registry.error) return registry.error;
  const known = new Set(
    registry.entries.filter((entry) => entry.kind === 'model').map((entry) => String(entry.name).toLowerCase()),
  );
  const unknown = [];
  for (const [model, file] of namedModels()) if (!known.has(model)) unknown.push(`${model} (${file})`);
  return summarize(unknown);
});

check(6, 'DISCLOSURE.md odpovídá registru', ({ registry }) => {
  if (registry.error) return registry.error;
  const path = join(REPO, RENDERED_FILE);
  if (!existsSync(path)) return `${RENDERED_FILE} chybí — spusť \`--sync\``;
  const onDisk = readFileSync(path, 'utf8');
  const expected = renderDisclosure(registry.entries);
  if (onDisk === expected) return null;
  return `${RENDERED_FILE} se rozešel s registrem — byl editovaný ručně? Spusť \`--sync\``;
});

// ---------------------------------------------------------------------------
// Sync a běh
// ---------------------------------------------------------------------------

function sync() {
  // Autor a copyright řádek se čtou z `node_modules/`. Bez nich obojí vyjde
  // prázdné a dosadí se náhradní text, který kontrolou 1 projde — takže `--sync`
  // na čerstvém klonu tiše smaže skutečná jména autorů a nechá registr, který
  // vypadá úplný. Naměřeno reviewem nad `47e0b02`: 99/168 skutečných autorů →
  // 0/168, a brána přitom vypsala „disclosure je úplná".
  if (!existsSync(join(REPO, 'node_modules'))) {
    console.log(
      'FAIL  --sync potřebuje node_modules/, ale ten tu není.\n' +
        '        Autor a copyright se čtou z balíčků; bez nich by se do registru zapsaly\n' +
        '        náhradní texty MÍSTO skutečných jmen a brána by to nepoznala.\n' +
        '        Spusť `npm ci` a zkus to znovu.',
    );
    process.exit(1);
  }

  const previous = existsSync(join(REPO, REGISTRY_FILE)) ? readJson(REGISTRY_FILE) : { entries: [] };
  const manual = (previous.entries ?? []).filter((entry) => !DERIVED_KINDS.includes(entry.kind));

  // Ruční pole u odvozených položek (typicky `reviewNote` u copyleftu) by se
  // regenerací ztratila, a brána by pak žádala, aby je někdo dopsal znovu.
  const carried = new Map();
  for (const entry of previous.entries ?? []) {
    if (DERIVED_KINDS.includes(entry.kind) && entry.reviewNote) carried.set(`${entry.kind}/${entry.name}`, entry.reviewNote);
  }
  const derived = [...deriveLibraries(), ...deriveAssets()].map((entry) => {
    const note = carried.get(`${entry.kind}/${entry.name}`);
    return note ? { ...entry, reviewNote: note } : entry;
  });

  const entries = [...derived, ...manual].sort(
    (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name),
  );

  writeFileSync(
    join(REPO, REGISTRY_FILE),
    `${JSON.stringify(
      {
        $comment:
          'Generováno `node scripts/license-gate.mjs --sync`. library a asset se odvozují ze stromu; model, dataset a api se píšou ručně a sync je nechává být.',
        entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(REPO, RENDERED_FILE), renderDisclosure(entries), 'utf8');
  console.log(`sync: ${derived.length} odvozených položek, ${manual.length} ručních → ${REGISTRY_FILE}, ${RENDERED_FILE}\n`);
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'license-gate — disclosure a licenční whitelist (RULES.md §2, §4)',
        '',
        '  node scripts/license-gate.mjs          ověří registr, exit 1 při nálezu',
        '  node scripts/license-gate.mjs --sync   přegeneruje library/asset a DISCLOSURE.md',
        '',
        'Ověřuje tvar registru, licence proti whitelistu, shodu s package-lock.json',
        'a public/ v obou směrech, pokrytí volaných endpointů a to, že DISCLOSURE.md',
        'je skutečně výpis registru a ne ručně psaný text.',
      ].join('\n'),
    );
    return 0;
  }

  if (argv.includes('--sync')) sync();

  const context = { registry: loadRegistry() };
  let failed = 0;

  console.log('license-gate — RULES.md §2 disclosure, §4 kontrola před npm install\n');
  for (const { id, title, run } of checks) {
    let detail;
    try {
      detail = run(context);
    } catch (error) {
      detail = `kontrola spadla: ${error.message}`;
    }
    if (detail) {
      failed += 1;
      console.log(`FAIL  [${id}] ${title}\n        ${detail}`);
    } else {
      console.log(`PASS  [${id}] ${title}`);
    }
  }

  console.log(
    failed === 0
      ? `\nVšech ${checks.length} kontrol prošlo — disclosure je úplná.`
      : `\n${failed} z ${checks.length} kontrol selhalo.`,
  );
  return failed === 0 ? 0 : 1;
}

// Spuštěno jako skript, ne importované testem. `pathToFileURL`, ne ruční
// `file://` — na Windows je `process.argv[1]` cesta s `D:\`, kterou by ruční
// složení URL zakódovalo jinak než `import.meta.url`, a brána by se nikdy
// nespustila.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { ALLOWED, ALLOWED_WITH_NOTE, KINDS, REQUIRED_FIELDS, main, noticesFor };
