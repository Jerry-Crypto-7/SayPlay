#!/usr/bin/env node
/**
 * Strojový checklist povinných deliverables (`RULES.md` §2).
 *
 * `RULES.md` §2 začíná větou *„chybí jeden = odmítnuto"*. Sedm položek, žádná
 * z nich se nedá dohnat po termínu, a šedesát dní práce se dá zahodit zapomenutou
 * disclosure. Tenhle skript je proti tomu: **vypíše, co chybí, a skončí nenulově**,
 * dokud chybí cokoli.
 *
 * ```
 * node scripts/submission-check.mjs             plný běh proti nasazené adrese
 * node scripts/submission-check.mjs --offline    přeskočí síť, exit 2
 * ```
 *
 * ## Tři návratové kódy, ne dva
 *
 * `0` prošlo všech osm kontrol · `1` aspoň jedna selhala · **`2` aspoň jedna se
 * přeskočila**. Dvojka existuje kvůli `--offline`: přeskočená kontrola není
 * splněná kontrola, a kdyby offline běh vracel nulu, byl by to nejlevnější
 * způsob, jak si odklikat zelenou bránu bez nasazení. `T804` proto smí uznat
 * jenom nulu z **plného** běhu.
 *
 * ## Běží proti nasazené adrese, ne proti localhostu
 *
 * AC úlohy to žádá výslovně a `isDeployedUrl()` to vynucuje: loopback, privátní
 * rozsahy a jména vyhrazená pro dokumentaci se odmítají dřív, než se na ně
 * sáhne. Bez toho by šlo odevzdat s `http://localhost:3000` v manifestu a brána
 * by zezelenala nad adresou, kterou hodnotitel nikdy neotevře.
 *
 * **Skript proto nemá vlastní testovací zkratku na síť.** Kontroly závislé na
 * síti se v testech volají přímo přes `runChecks()` s podvrženým `fetchImpl`;
 * proces sám žádnou proměnnou prostředí, která by síť zfalšovala, nečte. Seam,
 * kterým jde bráně podstrčit odpověď, je seam, kterým jde bránu obejít.
 *
 * ## Co se odvozuje ze skutečnosti a co jen ze zápisu
 *
 * Disclosure (kontrola 6) se nesmí ptát registru, jestli je úplný — to by byla
 * kruhová odpověď. Úplnost každé z pěti tříd má proto vlastní odvození:
 *
 * | Třída | Odkud se odvozuje úplnost | Kdo to měří |
 * |---|---|---|
 * | `library` | `package-lock.json` | `license-gate.mjs` kontrola 3 |
 * | `asset` | enumerace `public/` | `license-gate.mjs` kontrola 4 |
 * | `api` | hosté v URL ve zdrojích | `license-gate.mjs` kontrola 5 |
 * | `model` | **jediná allowlistovaná tabulka konstant** | tenhle soubor |
 * | `dataset` | datové adresáře **a** váha literálů v AST | tenhle soubor |
 *
 * První tři už umí `license-gate.mjs` a tenhle skript ho proto **spouští**, ne
 * opisuje. Dvě zbylé třídy měl otevřené a jsou dopsané tady.
 *
 * ## Co tenhle skript nezavře, a je to napsané schválně
 *
 * Práh na váhu literálů je hranice, a **každá hranice má pod sebou díru**:
 * externí seznam kódů o dvou kilobajtech projde. Snížit práh znamená hlásit
 * běžné konstanty, takže se to takhle zavřít nedá — a plán s tím počítá.
 * Zbytek přebírá **podepsaná inventura v T804** nad `git ls-files` bez jediné
 * výjimky. Automatika snižuje, co si autor musí pamatovat; disclosure podle
 * `RULES.md` §2 je nakonec jeho prohlášení, ne měření.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

import { modelIdsIn } from './license-gate.mjs';

/** Strom, který se kontroluje. Přepisuje ho `buildContext({ repo })` v testech. */
const REPO = process.cwd();

/**
 * Kde bydlí sourozenecké brány. **Není to `repo`** — `license-gate.mjs` a
 * `blind-check.mjs` se spouštějí odsud a měří strom v `repo`. Kdyby se hledaly
 * v `repo`, ukázala by fixtura na vlastní kopii brány a test by měřil ji.
 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export const MANIFEST_FILE = 'docs/submission/submission.json';
export const PLAN_FILE = 'plans/P8-odevzdani.md';
export const REGISTRY_FILE = 'disclosure.json';

/**
 * Direktiva „tohle ještě nikdo nevyplnil". Stejná konvence jako `UNPROVISIONED`
 * v `cleanroom-check.mjs`: nevyplněné pole musí bránu shodit, ne projít jako
 * pravdivá hodnota. Bez toho by manifest s prázdnými řetězci prošel čtyřmi
 * kontrolami, které mají hlídat, že je vyplněný.
 */
export const PLACEHOLDER = /^TODO:/;

/** `RULES.md` §2: tvrdý limit videa. Ne doporučení, ne „kolem tří minut". */
export const VIDEO_LIMIT_SECONDS = 180;

/**
 * Kolik prózy musí popis mít, aby nebyl zástupný. Měří se text po odstranění
 * markdown syntaxe — nadpisy, odrážky a odkazy nejsou popis projektu.
 *
 * Práh je záměrně nízký: kontrola má chytit **prázdný nebo zástupný soubor**,
 * ne soudit kvalitu textu. Krátký a dobrý popis existuje, prázdný ne.
 */
export const DESCRIPTION_MIN_CHARS = 1200;

/**
 * Práh AST kontroly na dataset vložený do zdrojového modulu.
 *
 * **Souhrnná velikost VŠECH literálů včetně řetězcových**, ne jen polí a objektů.
 * Serializovaný dataset (JSON v jednom řetězci, base64 blob) by pod prahem
 * mířeným na kolekce prošel celý — a to je přesně ten tvar, kterým se dataset
 * do zdrojáku dostane, když ho tam někdo nechce mít vidět.
 */
export const LITERAL_BYTES_LIMIT = 4096;

/** Druhá půlka téhož prahu: kolekce, která je dlouhá, i když je v ní málo bajtů. */
export const COLLECTION_ITEMS_LIMIT = 200;

/**
 * Jak často nejméně musí hlídač dostupnosti měřit, aby to bylo „průběžné
 * hlídání" a ne jednorázová odpověď. Patnáct minut je strop, ne cíl.
 */
export const MONITOR_MAX_INTERVAL_SECONDS = 900;

/**
 * `RULES.md` §2 chce backend živý do **25. 11.**, tedy dva týdny po odevzdání.
 * Hlídání, které skončí dřív, tenhle deliverable nepokrývá.
 */
export const COVERAGE_UNTIL = '2026-11-25';

/**
 * Kolik násobků deklarovaného intervalu smí být poslední záznam hlídače starý,
 * než se hlídání považuje za mrtvé. Tři, aby jedno vynechané měření bránu
 * neshodilo, a zároveň aby hlídač vypnutý před hodinou neprošel jako živý.
 */
export const HEARTBEAT_STALE_MULTIPLE = 3;

/** Přípony, které se považují za zdrojový modul pro AST kontrolu. */
const CODE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

/**
 * Hostitelská jména, která nejsou nasazená adresa. Loopback a privátní rozsahy
 * proto, že je hodnotitel neotevře; jména vyhrazená pro dokumentaci proto, že
 * je nikdo nevlastní a odpověď z nich nic nedokazuje.
 */
const NOT_DEPLOYED = [
  [/^localhost$/i, 'localhost'],
  [/\.localhost$/i, 'jméno v doméně .localhost'],
  [/^127\./, 'loopback 127.0.0.0/8'],
  [/^0\.0\.0\.0$/, 'nespecifikovaná adresa'],
  [/^\[?::1]?$/, 'loopback ::1'],
  [/^10\./, 'privátní rozsah 10.0.0.0/8'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'privátní rozsah 172.16.0.0/12'],
  [/^192\.168\./, 'privátní rozsah 192.168.0.0/16'],
  [/^169\.254\./, 'link-local 169.254.0.0/16'],
  [/\.(local|test|invalid|example)$/i, 'doména vyhrazená pro dokumentaci'],
  [/^(www\.)?example\.(com|net|org)$/i, 'doména vyhrazená pro dokumentaci'],
];

// ---------------------------------------------------------------------------
// Čtení repozitáře
// ---------------------------------------------------------------------------

/**
 * `--no-replace-objects` jako pre-subcommand flag na **každém** volání gitu.
 * `git replace` umí podstrčit jiné bajty pod nezměněné OID a náhrady jsou
 * defaultně zapnuté, takže bez tohohle flagu by šlo projít inventurou nad
 * obsahem, který se do veřejného repozitáře nahraje jiný.
 */
function git(repo, args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Sledované cesty. **Sledované, ne cokoli na disku** — publikuje se to, co je
 * v repozitáři, takže netrackovaný soubor kontrolu nezajímá a naopak sledovaný
 * soubor v `.gitignore` neexistuje.
 */
function trackedPaths(repo) {
  return git(repo, ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((path) => path.split(sep).join(posix.sep));
}

/**
 * Obsah sledovaných souborů **z indexu, ne z disku** — jedním voláním
 * `git cat-file --batch`, ne jedním na soubor.
 *
 * Publikuje se to, co je v repozitáři. Kdyby se skenoval pracovní strom, dal by
 * se dataset stagenout a z disku smazat, a AST kontrola by nad ním hlásila čistý
 * strom. Je to táž volba, jakou `license-gate.mjs` popisuje u své vlastní cesty,
 * a obě poloviny kontroly 6 tak čtou tentýž zdroj.
 *
 * **Neplatí to pro vstupy, které píše člověk** (manifest, popis, plán, reporty).
 * Ty se čtou z disku: je to obsluha brány, ne materiál, který se publikuje.
 */
function trackedSources(repo, wanted) {
  const listed = git(repo, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [, oid] = meta.split(' ');
      return { oid, path: path.split(sep).join(posix.sep) };
    })
    .filter(({ path }) => wanted(path));

  const sources = new Map();
  if (listed.length === 0) return sources;

  const batch = spawnSync('git', ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: repo,
    input: `${listed.map(({ oid }) => oid).join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (batch.status !== 0) throw new Error(`git cat-file selhal: ${String(batch.stderr)}`);

  const out = batch.stdout;
  let at = 0;
  for (const { path } of listed) {
    const newline = out.indexOf(0x0a, at);
    if (newline === -1) throw new Error(`git cat-file vrátil kratší výstup, než kolik bylo souborů (${path})`);
    const size = Number(out.toString('latin1', at, newline).split(' ')[2]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file nevrátil velikost pro ${path}`);
    sources.set(path, out.toString('utf8', newline + 1, newline + 1 + size));
    at = newline + 1 + size + 1;
  }
  return sources;
}

function readText(repo, path) {
  return readFileSync(join(repo, path), 'utf8');
}

function readJson(repo, path) {
  return JSON.parse(readText(repo, path));
}

export function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim() === '' || PLACEHOLDER.test(value.trim());
}

// ---------------------------------------------------------------------------
// Čisté funkce, na kterých kontroly stojí
// ---------------------------------------------------------------------------

/**
 * Je to adresa, na kterou se dá poslat hodnotitel? Vrací `null` když ano, jinak
 * důvod. Kontroluje **tvar adresy**, ne dosažitelnost — ta je na `probe()`.
 */
export function isDeployedUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return 'není platná URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `protokol "${url.protocol}" není http(s)`;
  // Prostý `http` projde jen proto, že demo za reverzní proxy může být na něm;
  // hlídat certifikát je práce hostingu, ne téhle brány.
  const host = url.hostname;
  for (const [pattern, reason] of NOT_DEPLOYED) if (pattern.test(host)) return `${host} je ${reason}, ne nasazená adresa`;
  if (!host.includes('.')) return `${host} není plně kvalifikované jméno`;
  return null;
}

/**
 * Délka MP4 ze **skutečných metadat kontejneru**, ne z názvu souboru ani
 * z důvěry v to, co kdo napsal do manifestu. Čte se `mvhd` uvnitř `moov`:
 * `duration / timescale` v sekundách.
 *
 * Vrací `null`, když se box nenajde — a to je selhání kontroly, ne nula. Soubor,
 * jehož délku nejde přečíst, není soubor pod třemi minutami.
 */
export function mp4DurationSeconds(buffer) {
  const findBox = (start, end, wanted) => {
    let at = start;
    while (at + 8 <= end) {
      let size = buffer.readUInt32BE(at);
      const type = buffer.toString('latin1', at + 4, at + 8);
      let header = 8;
      if (size === 1) {
        if (at + 16 > end) return null;
        // 64bitová velikost. `Number` je bezpečný: soubor většího rozsahu než
        // 2^53 bajtů neexistuje, a kdyby existoval, nevejde se do bufferu.
        size = Number(buffer.readBigUInt64BE(at + 8));
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) return null;
      if (type === wanted) return { body: at + header, end: at + size };
      at += size;
    }
    return null;
  };

  const moov = findBox(0, buffer.length, 'moov');
  if (!moov) return null;
  const mvhd = findBox(moov.body, moov.end, 'mvhd');
  if (!mvhd) return null;

  const version = buffer.readUInt8(mvhd.body);
  // Verze 0 nese timescale a duration jako 32bitová čísla za 1 bajtem verze,
  // 3 bajty příznaků a dvěma časy; verze 1 má časy 64bitové, takže je posun jiný.
  const at = mvhd.body + 4 + (version === 1 ? 16 : 8);
  if (version === 1) {
    if (at + 12 > mvhd.end) return null;
    const timescale = buffer.readUInt32BE(at);
    const duration = Number(buffer.readBigUInt64BE(at + 4));
    return timescale > 0 ? duration / timescale : null;
  }
  if (at + 8 > mvhd.end) return null;
  const timescale = buffer.readUInt32BE(at);
  const duration = buffer.readUInt32BE(at + 4);
  return timescale > 0 ? duration / timescale : null;
}

/** Current English submission copy contract for WORLDSTREAM — the product the
 * judge actually opens: a sentence becomes a 3D world with executable rules.
 *
 * **Přepsáno 16. 9. 2026 (P18 T10).** Do té doby tenhle seznam vymáhal slovník
 * Reality Compiler pilotu — „seven parameter groups", „one timer intervention",
 * „short source". Ta věta popisuje jiný produkt, než jaký je na demo adrese, a
 * kontrola tím nutila popis lhát: zelená brána nad popisem cizího produktu je
 * horší než červená. Sedm položek níž jsou omezení **tohoto** produktu a každé
 * je doložené — `docs/demo/judge-runbook.md` (náhrada uvařeným světem, limit
 * druhé věty, chybějící přetáčení času), `evals/worldstream/latency-report.json`
 * (původ časů) a hodnocení G1 (2 z 10 poznaných místností).
 *
 * Jsou to disclosure požadavky, ne automatická sémantická revize. Formulace i
 * rozvržení se smí měnit; smysl celého popisu pořád soudí člověk.
 */
const DESCRIPTION_DISCLOSURES = [
  ['sentence-scope', /\bsentence\b[^.!?]{0,120}\b(?:3D|three.dimensional)\b/i,
    /\bdeterministic\b[^.!?]{0,80}\brules?\b/i],
  // Porotce smí psát vlastní věty (`RULES.md` §3.3). Že na neznámou větu
  // odpoví nejbližší uvařený svět, je ta nejdůležitější věc, kterou o sobě
  // tenhle produkt musí říct nahlas — a musí říct i to, že to přizná na obrazovce.
  ['authored-fallback', /\bnearest\b[^.!?]{0,80}\bauthored world\b/i,
    /\bauthored world\b[^.!?]{0,80}\blabels?\b/i],
  ['second-sentence-limit', /\bsecond sentence\b/i, /\b(?:refused|rejected|declined)\b/i],
  ['no-time-rewind', /\btime rewind\b[^.!?]{0,120}\bnot on\b/i],
  // Nejdůležitější omezení tohohle produktu a jediné, které se z hotového
  // snímku nepozná: svět projde všemi strukturálními kontrolami a přitom
  // neznamená, co věta říkala. G1 (16. 9. 2026) to naměřila jako 2 z 10.
  ['semantic-limit', /\b(?:not a semantic guarantee|(?:does not|cannot) (?:certify|guarantee|establish) semantic (?:correctness|accuracy))\b/i],
  ['geometry-limit', /\bgeometry\b[^.!?]{0,35}\bschematic\b/i],
  ['latency-provenance', /\b(?:CLI|generation|creation) timings?\b[^.!?]{0,100}\b(?:include|includes)\b[^.!?]{0,100}\b(?:process|transport) overhead\b/i,
    /\bauthored store\b[^.!?]{0,60}\bnot a live model\b/i],
  ['independent-review', /\bindependent semantic review\b/i, /\b(?:usability|human|five.person)\b[^.!?]{0,100}\b(?:evidence|study|review)\b/i],
];

export function descriptionContractProblems(text) {
  // Comments/code are not disclosures visible in the written submission.
  const prose = proseOf(text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ''));
  return DESCRIPTION_DISCLOSURES.filter(([, ...patterns]) => !patterns.every(pattern => pattern.test(prose)))
    .map(([id]) => `chybí aktuální disclosure ${id} (WORLDSTREAM)`);
}

/** Text bez rozdílů, které nejsou obsahem: zalomení, dvojité mezery, nbsp. */
export function normalizeProse(text) {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Čísla, která nejsou k nerozeznání od čehokoli jiného: zlomky (`2/27`) a
 * desetinná čísla (`7,4`). Holé celé číslo se sem nebere schválně — „3" v popisu
 * nedokazuje, že autor citoval měření.
 */
export function distinctiveNumbers(text) {
  const found = new Set();
  for (const match of text.matchAll(/\b\d+\/\d+\b|\b\d+[.,]\d+\b/g)) found.add(match[0]);
  return found;
}

/** Popis bez markdown syntaxe — nadpisy, odrážky, odkazy a zvýraznění nejsou próza. */
export function proseOf(markdown) {
  return normalizeProse(
    markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
      .replace(/^\s{0,3}[-*+]\s+/gm, ' ')
      .replace(/^\s{0,3}>\s?/gm, ' ')
      .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
      .replace(/[*_`|]/g, ' '),
  );
}

/** Focus kategorie tak, jak ji uvádí odevzdávaný popis. */
export function focusCategoryInDescription(text) {
  const match = text.match(/^\*\*Focus kategorie:\*\*\s*(.+?)\s*$/m);
  return match ? match[1] : null;
}

/** Focus kategorie tak, jak byla zapsaná při registraci (P0 T107 → plán P8). */
export function focusCategoryInRegistration(text) {
  const match = text.match(/<!--\s*registrace:\s*focus-kategorie\s*=\s*(.+?)\s*-->/);
  return match ? match[1] : null;
}

/**
 * Váha literálů v jednom modulu. `bytes` je součet obsahu **všech** literálů
 * včetně řetězcových a šablonových, `items` je nejdelší pole nebo objekt.
 *
 * Komentáře se nepočítají — dokumentační blok o pěti kilobajtech je dokumentace,
 * ne dataset, a počítat ho by z prahu udělalo trest za psaní komentářů.
 */
export function literalWeight(path, source) {
  const kind = /\.(mjs|cjs|js)$/.test(path)
    ? ts.ScriptKind.JS
    : path.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);

  let bytes = 0;
  let items = 0;
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      bytes += Buffer.byteLength(node.text, 'utf8');
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      bytes += Buffer.byteLength(node.text, 'utf8');
    } else if (ts.isNumericLiteral(node)) {
      bytes += node.getText().length;
    }
    if (ts.isArrayLiteralExpression(node)) items = Math.max(items, node.elements.length);
    if (ts.isObjectLiteralExpression(node)) items = Math.max(items, node.properties.length);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { bytes, items };
}

/** Je cesta pokrytá registrovanou položkou? Přesná shoda, nebo prefix adresáře. */
export function coveredByPaths(path, registered) {
  for (const entry of registered) {
    if (path === entry) return true;
    if (entry.endsWith('/') ? path.startsWith(entry) : path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Tabulky, ve kterých smí stát jméno modelu. **Množné číslo je naměřený tvar,
 * ne obecnost pro jistotu:** produkt má tabulku `src/model/prompt.ts`, měřicí
 * řetězec má vlastní (`LIVE_MODELS` v `evals/harness/preflight.ts`) a jedna
 * tabulka pro obojí neexistuje — jsou to dvě různé sady modelů pro dvě různé
 * cesty. Dokud tu stálo jedno pole, hlásila kontrola tu druhou jako nález, i
 * když všechny čtyři její identifikátory v registru byly.
 *
 * Starý klíč `modelTablePath` se pořád přečte: manifest je vstup a mlčky ho
 * ignorovat by znamenalo bránu vypnout přejmenováním pole.
 */
export function modelTablePaths(manifest) {
  const many = Array.isArray(manifest?.modelTablePaths) ? manifest.modelTablePaths : [];
  const one = manifest?.modelTablePath;
  const all = [...many, ...(typeof one === 'string' ? [one] : [])]
    .map((path) => String(path))
    .filter((path) => !isPlaceholder(path));
  return [...new Set(all)];
}

/** Adresáře, jejichž obsah se nikam nenasazuje. */
const TOOLING_ROOTS = ['scripts/', 'ops/', 'evals/', 'e2e/'];

/**
 * Nástroj, ne produkt: testy, fixtury, měřicí harnesy a provozní skripty.
 *
 * Pravidlo o **umístění** literálu platí na produkt — `src/**` a nasazený
 * runtime. Nástroj z něj vyjmutý je proto, že rozptýlený literál v produkci
 * je ta díra, kvůli které kontrola vznikla; literál v nástroji se za běhu
 * nikam nedostane a bývá právě tím, co ten nástroj měří nebo ověřuje.
 *
 * **Registraci to nepromíjí** — podmínka výš platí i tady, takže třetí strana
 * jmenovaná jenom v harnesu z disclosure neuteče.
 *
 * Rozhodnuto 18. 9. 2026 nad naměřenými 15 nálezy (0 nezveřejněných modelů,
 * 10 v `*.measure.ts`, 5 v provozních a měřicích skriptech). Druhá zvažovaná
 * podoba — napojit všech 15 souborů na jediný zdroj jména — je zamítnutá:
 * `ops/host/preflight.mjs` tvrdí, že proměnná prostředí se rovná
 * `gpt-6-astra`, a kdyby to jméno četl z téhož místa, prošlo by mu cokoli.
 *
 * Polarita je schválně opačná než allowlist cest: vyjmenované jsou
 * **nástroje**, takže nový adresář produktu spadá pod pravidlo od prvního
 * dne, aniž si na něj někdo vzpomene.
 */
export function isToolingPath(path) {
  return TOOLING_ROOTS.some((root) => path.startsWith(root))
    || /(^|[/])__tests__([/]|$)/.test(path)
    || /[.](test|measure)[.](ts|tsx|mts|mjs|js)$/.test(path);
}

/** Cesty deklarované položkami `kind: dataset`. */
export function datasetPaths(registry) {
  const paths = [];
  for (const entry of registry.entries ?? []) {
    if (entry?.kind !== 'dataset') continue;
    for (const path of entry.paths ?? []) paths.push(String(path));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Síť
// ---------------------------------------------------------------------------

/**
 * Jedno HTTP GET. **Bez přihlašovacích údajů** — repozitář a demo musí být
 * dostupné komukoli, a odpověď získaná s tokenem by dokazovala pravý opak.
 */
async function probe(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'submission-check' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text().catch(() => '');
    return {
      status: response.status,
      contentType: String(response.headers?.get?.('content-type') ?? ''),
      length: body.length,
    };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/** Adresa je platná, nasazená a odpovídá. Vrací důvod selhání, nebo `null`. */
async function reachable(fetchImpl, label, url) {
  if (isPlaceholder(url)) return `${label} není v ${MANIFEST_FILE} vyplněná`;
  const shape = isDeployedUrl(url);
  if (shape) return `${label}: ${shape}`;
  const result = await probe(fetchImpl, url);
  if (result.error) return `${label} (${url}) neodpověděla: ${result.error}`;
  if (result.status < 200 || result.status >= 300) return `${label} (${url}) odpověděla ${result.status}`;
  return null;
}

// ---------------------------------------------------------------------------
// Kontroly — čísla odpovídají pořadí v `RULES.md` §2
// ---------------------------------------------------------------------------

const checks = [];
const check = (id, title, needsNetwork, run) => checks.push({ id, title, needsNetwork, run });

function summarize(problems) {
  if (problems.length === 0) return null;
  const shown = problems.slice(0, 3).join('\n        ');
  const rest = problems.length > 3 ? `\n        … a dalších ${problems.length - 3}` : '';
  return `${problems.length} nálezů:\n        ${shown}${rest}`;
}

check(1, 'veřejný repozitář je dostupný', true, ({ manifest, fetchImpl }) =>
  reachable(fetchImpl, 'repositoryUrl', manifest.repositoryUrl),
);

check(2, 'hostovaný demo link odpovídá v prohlížeči', true, async ({ manifest, fetchImpl }) => {
  const failure = await reachable(fetchImpl, 'demoUrl', manifest.demoUrl);
  if (failure) return failure;
  // Demo má být stránka, ne JSON ani přesměrování na stažení souboru.
  // `RULES.md` §3: plně v prohlížeči, bez instalace.
  const result = await probe(fetchImpl, manifest.demoUrl);
  if (!/text\/html/i.test(result.contentType)) {
    return `demoUrl vrací content-type "${result.contentType}", ne text/html — to není stránka v prohlížeči`;
  }
  return null;
});

check(3, 'demo video existuje a je pod 3:00', false, ({ repo, manifest }) => {
  const path = manifest.videoPath;
  if (isPlaceholder(path)) return `videoPath není v ${MANIFEST_FILE} vyplněná`;
  const full = join(repo, path);
  if (!existsSync(full)) return `${path} neexistuje`;

  // Čte se hlavička, ne celý soubor: `moov` bývá na začátku a tříminutové video
  // má desítky megabajtů, které do paměti brány nepatří. Když je `moov` až na
  // konci (nezoptimalizovaný export), přečte se celý soubor — a to je správně,
  // protože jinak by kontrola hlásila „délku nejde přečíst" nad platným videem.
  const size = statSync(full).size;
  const head = Buffer.alloc(Math.min(size, 512 * 1024));
  const handle = openSync(full, 'r');
  try {
    readSync(handle, head, 0, head.length, 0);
  } finally {
    closeSync(handle);
  }
  let seconds = mp4DurationSeconds(head);
  if (seconds === null && size > head.length) seconds = mp4DurationSeconds(readFileSync(full));
  if (seconds === null) return `${path}: v souboru není čitelný box mvhd, délku nejde ověřit`;
  if (seconds > VIDEO_LIMIT_SECONDS) {
    return `${path} má ${seconds.toFixed(1)} s, tvrdý limit je ${VIDEO_LIMIT_SECONDS} s`;
  }
  return null;
});

export function checkDescription({ repo, manifest }) {
  const path = manifest.descriptionPath;
  if (isPlaceholder(path)) return `descriptionPath není v ${MANIFEST_FILE} vyplněná`;
  if (!existsSync(join(repo, path))) return `${path} neexistuje`;
  const text = readText(repo, path);
  const problems = [];

  const prose = proseOf(text);
  if (prose.length < DESCRIPTION_MIN_CHARS) {
    problems.push(`${path} má ${prose.length} znaků prózy, práh je ${DESCRIPTION_MIN_CHARS}`);
  }

  problems.push(...descriptionContractProblems(text).map(problem => `${path}: ${problem}`));

  // Aspoň jedno naměřené číslo. Popis bez čísel je marketing; číslo, které
  // v žádném reportu není, je odhad vydávaný za měření.
  const reports = manifest.measurementReports ?? [];
  if (reports.length === 0) {
    problems.push(`${MANIFEST_FILE} neuvádí jediný report v "measurementReports"`);
  } else {
    const measured = new Set();
    for (const report of reports) {
      if (!existsSync(join(repo, report))) {
        problems.push(`${report} neexistuje, ale manifest ho uvádí jako zdroj čísel`);
        continue;
      }
      for (const number of distinctiveNumbers(readText(repo, report))) measured.add(number);
    }
    const cited = [...distinctiveNumbers(text)].filter((number) => measured.has(number));
    if (measured.size === 0) {
      problems.push(`reporty ${reports.join(', ')} neobsahují ověřitelné naměřené číslo`);
    } else if (cited.length === 0) {
      problems.push(`${path} neuvádí jediné číslo, které by stálo v ${reports.join(', ')}`);
    }
  }

  return summarize(problems);
}
check(4, 'písemný popis existuje a není zástupný', false, checkDescription);

check(5, 'focus kategorie je zvolená a shodná s registrací', false, ({ repo, manifest }) => {
  const path = manifest.descriptionPath;
  if (isPlaceholder(path) || !existsSync(join(repo, path))) return `popis chybí, kategorii nejde odkud přečíst`;

  const chosen = focusCategoryInDescription(readText(repo, path));
  const registered = focusCategoryInRegistration(readText(repo, PLAN_FILE));

  // **Dvě nezávislé strany, ne kopie jedné.** Kategorie v registraci se zapsala
  // do plánu při T107, tedy měsíce před odevzdáním; kategorie v popisu je to, co
  // uvidí hodnotitel. Porovnávat popis se sebou samým by nedokázalo nic.
  if (!chosen) return `${path} neuvádí řádek "**Focus kategorie:** …"`;
  if (!registered) return `${PLAN_FILE} nenese značku "<!-- registrace: focus-kategorie = … -->" z T107`;
  if (isPlaceholder(registered)) return `${PLAN_FILE}: kategorie z registrace ještě není doplněná ("${registered}")`;
  if (chosen.toLowerCase() !== registered.toLowerCase()) {
    return `popis uvádí "${chosen}", registrace "${registered}" — to je materiální rozpor s přihláškou`;
  }
  return null;
});

check(6, 'disclosure je úplná napříč pěti třídami', false, ({ repo, manifest, registry, sources }) => {
  const problems = [];

  // (a) Tři třídy, které umí odvodit `license-gate.mjs`. Spouští se, ne opisuje —
  // druhá kopie téže kontroly je druhý zdroj pravdy a ty dva se rozejdou.
  const gate = spawnSync(process.execPath, [join(SCRIPT_DIR, 'license-gate.mjs')], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (gate.status !== 0) {
    const failures = [...String(gate.stdout ?? '').matchAll(/^FAIL {2}\[(\d+)] (.+)$/gm)].map(
      (match) => `license-gate [${match[1]}] ${match[2]}`,
    );
    problems.push(...(failures.length > 0 ? failures : [`license-gate skončil kódem ${gate.status}`]));
  }

  // (b) `model` — registr napřed, umístění potom.
  //
  // Do 24. 8. 2026 se tu ptalo **jenom na umístění**: model jmenovaný mimo
  // tabulku byl nález, a proti registru se kontrolovaly výhradně identifikátory
  // uvnitř té tabulky. Naměřeno v T28: 7 nálezů, z toho **0 nezveřejněných
  // třetích stran** — šest testovacích fixtur a jedna druhá tabulka. Přitom
  // identifikátor v testu se do registru nedostane úplně stejně jako
  // identifikátor v produkci, a na ten se stará podoba neptala vůbec.
  //
  // Nová podoba se ptá na obojí a v tomhle pořadí:
  //  1. **každý** identifikátor kdekoli musí být v registru jako `kind: model`
  //     — to je disclosure otázka a je přísnější než dřív;
  //  2. mimo deklarované tabulky ho smí jmenovat jen nástroj — test, fixtura,
  //     měřicí harness nebo provozní skript — to je otázka pořádku v kódu
  //     a zůstává, protože právě rozptýlený literál v produkci je ta díra,
  //     kvůli které kontrola vznikla. Hranici drží `isToolingPath()` a její
  //     odůvodnění stojí u ní.
  const tables = modelTablePaths(manifest);
  if (tables.length === 0) {
    problems.push(`${MANIFEST_FILE} neurčuje "modelTablePaths" — bez nich není co allowlistovat`);
  }
  for (const table of tables) {
    if (!sources.has(table)) problems.push(`modelTablePaths "${table}" není sledovaný zdrojový soubor`);
  }
  const known = new Set(
    (registry.entries ?? [])
      .filter((entry) => entry?.kind === 'model')
      .map((entry) => String(entry.name).toLowerCase()),
  );
  for (const [path, source] of sources) {
    const ids = modelIdsIn(source);
    if (ids.size === 0) continue;
    for (const id of ids) {
      if (!known.has(id)) problems.push(`${path}: model "${id}" není v registru jako kind: model`);
    }
    if (tables.includes(path) || isToolingPath(path)) continue;
    // Hlásí se cesta, ne jen jméno — jinak se nedá opravit.
    problems.push(`${path} jmenuje model ${[...ids].join(', ')} mimo tabulky ${tables.join(', ')}`);
  }

  // (c) `dataset` (i) — každý soubor v datových adresářích má registrovanou cestu.
  const registered = datasetPaths(registry);
  const dataDirs = manifest.dataDirs ?? [];
  if (dataDirs.length === 0) {
    problems.push(`${MANIFEST_FILE} neuvádí jediný adresář v "dataDirs"`);
  }
  for (const path of trackedPaths(repo)) {
    if (!coveredByPaths(path, dataDirs)) continue;
    if (!coveredByPaths(path, registered)) problems.push(`${path} leží v datovém adresáři, ale žádná položka kind: dataset ho nepokrývá`);
  }

  // (d) `dataset` (ii) — váha literálů nad celým sledovaným stromem.
  for (const [path, source] of sources) {
    if (coveredByPaths(path, registered)) continue;
    const { bytes, items } = literalWeight(path, source);
    if (bytes > LITERAL_BYTES_LIMIT) {
      problems.push(`${path} nese ${bytes} B literálů (práh ${LITERAL_BYTES_LIMIT}) a není registrovaný jako kind: dataset`);
    } else if (items > COLLECTION_ITEMS_LIMIT) {
      problems.push(`${path} má kolekci o ${items} položkách (práh ${COLLECTION_ITEMS_LIMIT}) a není registrovaný jako kind: dataset`);
    }
  }

  return summarize(problems);
});

check(7, 'backend odpovídá a dostupnost se průběžně hlídá s alertem', true, async ({ repo, manifest, fetchImpl, now }) => {
  const failure = await reachable(fetchImpl, 'backendUrl', manifest.backendUrl);
  if (failure) return failure;

  const path = manifest.monitoringPath;
  if (isPlaceholder(path)) return `${MANIFEST_FILE} neurčuje "monitoringPath"`;
  if (!existsSync(join(repo, path))) {
    // Jednorázová odpověď dokazuje jednu vteřinu. `RULES.md` §2 chce provoz po
    // celou dobu hodnocení, a to je tvrzení o budoucnosti — dokázat ho může
    // jedině hlídač, který měří dál, když se nikdo nedívá.
    return `${path} neexistuje — backend odpověděl, ale nikdo nehlídá, jestli odpovídá dál`;
  }

  const monitor = readJson(repo, path);
  const problems = [];
  const targets = new Map((monitor.targets ?? []).map((target) => [String(target?.url), target]));
  for (const [label, url] of [
    ['repositoryUrl', manifest.repositoryUrl],
    ['demoUrl', manifest.demoUrl],
    ['backendUrl', manifest.backendUrl],
  ]) {
    if (!targets.has(String(url))) problems.push(`hlídač nesleduje ${label} (${url})`);
  }

  const interval = Number(monitor.intervalSeconds);
  if (!Number.isFinite(interval) || interval <= 0 || interval > MONITOR_MAX_INTERVAL_SECONDS) {
    problems.push(`intervalSeconds "${monitor.intervalSeconds}" není interval do ${MONITOR_MAX_INTERVAL_SECONDS} s`);
  }

  const until = Date.parse(String(monitor.coverageUntil));
  if (!Number.isFinite(until) || until < Date.parse(COVERAGE_UNTIL)) {
    problems.push(`coverageUntil "${monitor.coverageUntil}" nepokrývá provoz do ${COVERAGE_UNTIL}`);
  }

  // Alert je to, co dělá z měření hlídání. Bez adresáta se výpadek zapíše do
  // souboru, na který se nikdo nepodívá — a to je totéž jako nehlídat.
  if (isPlaceholder(monitor.alert?.channel) || isPlaceholder(monitor.alert?.destination)) {
    problems.push('alert nemá vyplněný kanál a adresáta');
  }

  // Poslední záznam dokazuje, že hlídač skutečně běží. Konfigurace bez záznamu
  // je záměr, ne hlídání.
  const beatPath = monitor.heartbeatPath;
  if (isPlaceholder(beatPath) || !existsSync(join(repo, beatPath))) {
    problems.push(`${beatPath ?? 'heartbeatPath'} neexistuje — hlídač je nakonfigurovaný, ale nikdy neběžel`);
  } else {
    const lines = readText(repo, beatPath).trim().split('\n').filter(Boolean);
    const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
    const at = last ? Date.parse(String(last.at)) : NaN;
    if (!Number.isFinite(at)) {
      problems.push(`${beatPath}: poslední záznam nemá čitelný čas "at"`);
    } else if (Number.isFinite(interval) && now - at > interval * HEARTBEAT_STALE_MULTIPLE * 1000) {
      const age = Math.round((now - at) / 1000);
      problems.push(`${beatPath}: poslední záznam je ${age} s starý, interval je ${interval} s — hlídač neběží`);
    }
    for (const url of [manifest.repositoryUrl, manifest.demoUrl, manifest.backendUrl]) {
      if (!(last?.targets ?? []).some((target) => String(target?.url) === String(url))) {
        problems.push(`${beatPath}: poslední záznam neměřil ${url}`);
      }
    }
  }

  return summarize(problems);
});

check(8, 'blind-check prošel — odevzdané artefakty neprozrazují autora', false, ({ repo }) => {
  // `RULES.md` §6 se po prvním pushi zpětně nespraví. Tahle kontrola je tady,
  // aby se na ni nedalo zapomenout mezi sedmi deliverables — spouští se skript
  // z P0 T105, ne jeho kopie.
  const result = spawnSync(process.execPath, [join(SCRIPT_DIR, 'blind-check.mjs')], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (result.status === 0) return null;
  const failures = [...String(result.stdout ?? '').matchAll(/^FAIL.*$/gm)].map((match) => match[0].trim());
  return summarize(failures.length > 0 ? failures : [`blind-check skončil kódem ${result.status}`]);
});

// ---------------------------------------------------------------------------
// Běh
// ---------------------------------------------------------------------------

/**
 * Kontext, který kontroly čtou. **`fetchImpl` a `now` jsou parametry, ne globály**,
 * aby šly síťové kontroly testovat bez sítě — ale jedině přes tenhle vstup, ne
 * přes proměnnou prostředí, kterou by šlo nastavit i ostrému běhu.
 */
export function buildContext({ repo = REPO, fetchImpl = fetch, now = Date.now() } = {}) {
  const manifest = existsSync(join(repo, MANIFEST_FILE)) ? readJson(repo, MANIFEST_FILE) : null;
  const registry = existsSync(join(repo, REGISTRY_FILE)) ? readJson(repo, REGISTRY_FILE) : { entries: [] };

  const sources = trackedSources(repo, (path) => CODE_FILE.test(path));
  return { repo, manifest, registry, sources, fetchImpl, now };
}

export async function runChecks(context, { offline = false } = {}) {
  const results = [];
  for (const { id, title, needsNetwork, run } of checks) {
    if (offline && needsNetwork) {
      results.push({ id, title, skipped: true, detail: 'přeskočeno (--offline)' });
      continue;
    }
    let detail;
    try {
      detail = await run(context);
    } catch (error) {
      // Spadlá kontrola není splněná kontrola. Tohle je jediné místo, kde by
      // výjimka mohla projít jako ticho, a ticho tady znamená „deliverable je
      // v pořádku" — přesně to tvrzení, které skript nesmí vyslovit omylem.
      detail = `kontrola spadla: ${error.message}`;
    }
    results.push({ id, title, skipped: false, detail: detail ?? null });
  }
  return results;
}

export async function main(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'submission-check — povinné deliverables podle RULES.md §2',
        '',
        '  node scripts/submission-check.mjs             plný běh proti nasazené adrese',
        '  node scripts/submission-check.mjs --offline   přeskočí síťové kontroly, exit 2',
        '',
        `Vstupy: ${MANIFEST_FILE}, ${REGISTRY_FILE}, ${PLAN_FILE}. Popis: aktuální Reality Compiler disclosure kontrakt.`,
        'Exit 0 jen když prošlo všech osm kontrol. Přeskočená kontrola není splněná.',
      ].join('\n'),
    );
    return 0;
  }

  const offline = argv.includes('--offline');
  console.log('submission-check — RULES.md §2, chybí jeden deliverable = odmítnuto');

  if (!existsSync(join(REPO, MANIFEST_FILE))) {
    console.log(`FAIL  ${MANIFEST_FILE} neexistuje — bez manifestu není co ověřovat.`);
    return 1;
  }

  const results = await runChecks(buildContext(), { offline });
  let failed = 0;
  let skipped = 0;
  for (const { id, title, detail, skipped: wasSkipped } of results) {
    if (wasSkipped) {
      skipped += 1;
      console.log(`SKIP  [${id}] ${title}`);
    } else if (detail) {
      failed += 1;
      console.log(`FAIL  [${id}] ${title}\n        ${detail}`);
    } else {
      console.log(`PASS  [${id}] ${title}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} z ${checks.length} kontrol selhalo — takhle se odevzdat nedá.`);
    return 1;
  }
  if (skipped > 0) {
    console.log(
      `\n${skipped} kontrol přeskočeno. Přeskočená kontrola NENÍ splněná kontrola —\n` +
        'před odevzdáním musí projít plný běh proti nasazené adrese.',
    );
    return 2;
  }
  console.log(`\nVšech ${checks.length} kontrol prošlo — deliverables podle RULES.md §2 jsou kompletní.`);
  return 0;
}

// `pathToFileURL`, ne ruční `file://` — na Windows je `process.argv[1]` cesta
// s `D:\`, kterou by ruční složení URL zakódovalo jinak než `import.meta.url`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
