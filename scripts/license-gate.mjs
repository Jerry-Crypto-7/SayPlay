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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const REGISTRY_FILE = 'disclosure.json';
const RENDERED_FILE = 'DISCLOSURE.md';
const LOCK_FILE = 'package-lock.json';

/** Pět tříd z AC. Registr nesmí nést nic jiného — neznámý `kind` je selhání, ne varování. */
const KINDS = ['library', 'asset', 'model', 'dataset', 'api'];

/**
 * Odvoditelné ze stromu, takže je `--sync` přepisuje. Zbytek je ruční a nedotčený.
 * `asset` mezi nimi **není**: z lockfilu se licence přečíst dá, z cesty v `public/` ne.
 */
const DERIVED_KINDS = ['library'];

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
/**
 * `mts` a `cts` tu jsou, protože bez nich se `scripts/*.d.mts` a jakýkoli `.mts`
 * zdroj neskenoval vůbec — kontroly 5 a 7 nad nimi mlčely a mlčení vypadalo
 * stejně jako čistý výsledek.
 */
const CODE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;

// ---------------------------------------------------------------------------
// Čtení stromu
// ---------------------------------------------------------------------------

/**
 * Ověřuje se **index**, ne pracovní strom — commituje se index. Klasické pořadí
 * kroků jinak bránu obejde: `--sync` přepíše `disclosure.json` i `DISCLOSURE.md`
 * na disku, člověk stagene jen jeden z nich, a brána certifikuje dvojici, která
 * se do commitu nikdy nedostane. Stejná vada, jakou vedle uzavřel `cleanroom-check`.
 *
 * `--sync` si disk vynutí: jeho úkolem je disk PŘEPSAT a pak nad ním rovnou
 * hlásit výsledek, takže čtení z indexu by mu ukazovalo obsah před jeho vlastní
 * prací. Mimo git repozitář (tarball, čerstvý rozbalený archiv) se čte disk taky —
 * index tam neexistuje a fail-closed by znamenalo, že brána nejde spustit vůbec.
 */
let sourceMode = 'index';
let trackedCache = null;

function trackedPaths() {
  if (trackedCache !== null) return trackedCache;
  try {
    const listing = execFileSync('git', ['--no-replace-objects', 'ls-files', '-z'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    trackedCache = new Set(listing.split('\0').filter(Boolean));
  } catch {
    trackedCache = null;
  }
  return trackedCache;
}

/** Obsah cesty tak, jak půjde do commitu. Netrackovaná cesta se čte z disku. */
function readTracked(path) {
  const tracked = sourceMode === 'index' ? trackedPaths() : null;
  if (!tracked || !tracked.has(path)) return readFileSync(join(REPO, path), 'utf8');
  return execFileSync('git', ['--no-replace-objects', 'show', `:${path}`], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function readJson(path) {
  return JSON.parse(readTracked(path));
}

function loadRegistry() {
  const tracked = sourceMode === 'index' ? trackedPaths() : null;
  const present = tracked?.has(REGISTRY_FILE) || existsSync(join(REPO, REGISTRY_FILE));
  if (!present) return { error: `${REGISTRY_FILE} chybí — spusť \`--sync\`` };
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
  const tracked = sourceMode === 'index' ? trackedPaths() : null;
  if (tracked) {
    // Index i disk: stagený asset se musí deklarovat, a netrackovaný soubor
    // v `public/` je asset, který se do commitu chystá.
    const out = new Set([...tracked].filter((path) => path.startsWith('public/')));
    for (const path of walkAssets()) out.add(path);
    return [...out].sort((a, b) => a.localeCompare(b));
  }
  return walkAssets();
}

function walkAssets() {
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
 * Znaky, po kterých `/` začíná regulární literál a ne dělení. Standardní
 * heuristika: po nich nemůže stát operand, takže `/` musí otevírat regex.
 *
 * **`<` tu schválně NENÍ, `>` ano.** S `<` v sadě otevřela uzavírací JSX značka
 * `</div>` falešný literál, ten doběhl k dalšímu `/` v následující URL, spolkl
 * přitom jednu uvozovku, stav uvozovek se rozešel a `//` v cestě se pak čtlo
 * jako komentář — takže zbytek řádku zmizel (naměřeno nad `a52bb71`).
 *
 * **`>` se ale vyhodit nesmělo a byla to druhá slepá skvrna.** Bez něj se
 * `(s) => /['"]/.test(s)` čte jako dělení, uvozovka uvnitř otevře režim řetězce
 * a host na dalším řádku zmizí — ověřeno, `hostsIn` vrátilo prázdno. Šipka je
 * v tomhle repu běžnější než cokoli, co `>` mimo sadu chránilo. JSX se pozná
 * podle `<` před lomítkem, ne podle `>` za značkou; `}` zůstává venku, protože
 * ho nic nepotřebuje a dělení za `}` je pravděpodobnější než regex.
 */
const REGEX_MAY_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '^', '>']);

/** Klíčová slova, po kterých platí totéž, jen končí písmenem (`return /x/`). */
const REGEX_MAY_FOLLOW_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'delete', 'void', 'instanceof', 'new']);

/**
 * Konec regulárního literálu začínajícího na `start`, nebo `-1`, když to literál
 * nebyl. Třídu `[...]` sleduje zvlášť: `/[//]/` má uvnitř dva lomítka a bez toho
 * by se braly jako začátek komentáře.
 */
function endOfRegex(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    // Regulární literál nepřeteče řádek. Když jsme na konci řádku, nebyl to on.
    if (c === '\n') return -1;
    // **Uvozovka uvnitř literál nediskvalifikuje.** Zkoušené to bylo a byla to
    // horší varianta: `/[^\]\s"'`]*\]/` v tomhle souboru se tím přestal
    // přeskakovat, jeho `"` otevřela režim řetězce, stav uvozovek se rozešel a
    // následující blokový komentář se přečetl jako obsah řetězce — takže brána
    // hlásila host z vlastní dokumentace. Falešný literál hlídá výběr
    // předcházejícího znaku, ne obsah spanu.
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Značka za znak, který **prohlížeč z URL zahodí** (`\t`, `\r`, `\n`) — WHATWG
 * URL je odstraňuje, takže `fetch('https://a.io\n@zly.net/v1')` jde na `zly.net`.
 * Kdyby se dekódovaly na skutečné bílé místo, nešly by odlišit od mezery, kterou
 * někdo do věty v řetězci napsal schválně, a brána by hlásila každou takovou větu.
 * Značka není bílé místo ani znak URL, takže shodu ukončí a jde se podle ní poznat.
 */
const INVISIBLE = '\u0001';

/**
 * Krátké escapy s vlastním významem. Zbytek (`\'`, `\\`, `\/`) je znak sám za sebe.
 *
 * `\n`, `\r` a `\t` tu mají **skutečný znak**, ne značku. Značku nasazuje jedno
 * jediné místo, `decodeEscapeMarked`, protože totéž jde napsat i unicode zápisem
 * a dvě místa se stejným úkolem znamenají, že mutační kontrola nad jedním z nich
 * nic neprokáže — jeden mutant tady přežil právě proto.
 */
const SHORT_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

/**
 * Dekóduje escape sekvenci v řetězcovém literálu na znak, který znamená.
 *
 * **Proč to nestačí zaslepit:** dřív se `\X` nahrazovalo dvěma mezerami, takže
 * `'https://api.openai.com@evil-exfil.net/v1'` skončilo pro skener na
 * mezeře a zbyl z něj registrovaný host. Naměřeno reviewem nad `a52bb71`:
 * kontrola 5 prošla zeleně nad voláním na `evil-exfil.net` napsaným takhle.
 */
function decodeEscape(source, i) {
  const c = source[i + 1];
  if (c === 'u') {
    if (source[i + 2] === '{') {
      const end = source.indexOf('}', i + 3);
      const body = end === -1 ? '' : source.slice(i + 3, end);
      if (/^[0-9a-f]{1,6}$/i.test(body)) {
        const code = Number.parseInt(body, 16);
        if (code <= 0x10ffff) return { text: String.fromCodePoint(code), length: end - i + 1 };
      }
    }
    const hex = source.slice(i + 2, i + 6);
    if (/^[0-9a-f]{4}$/i.test(hex)) return { text: String.fromCharCode(Number.parseInt(hex, 16)), length: 6 };
  }
  if (c === 'x') {
    const hex = source.slice(i + 2, i + 4);
    if (/^[0-9a-f]{2}$/i.test(hex)) return { text: String.fromCharCode(Number.parseInt(hex, 16)), length: 4 };
  }
  const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4));
  if (octal) return { text: String.fromCharCode(Number.parseInt(octal[0], 8)), length: 1 + octal[0].length };
  if (c in SHORT_ESCAPES) return { text: SHORT_ESCAPES[c], length: 2 };
  return { text: c ?? '', length: 2 };
}

/**
 * Dekódovaný znak, který `fetch` z URL zahodí, dostane značku — ať byl zapsaný
 * krátkým escapem, nebo jeho unicode zápisem. Bez toho by druhý zápis obcházel
 * to, co první hlídá, a obcházel by ho stejným způsobem.
 */
function decodeEscapeMarked(source, i) {
  const decoded = decodeEscape(source, i);
  if (decoded.text === '\n' || decoded.text === '\r' || decoded.text === '\t') {
    return { text: INVISIBLE, length: decoded.length };
  }
  return decoded;
}

/**
 * Odstraní komentáře, řetězce nechá. Rozhoduje to o tom, co je *volaný* endpoint:
 * URL v dokumentačním komentáři nikdo nezavolá, URL v řetězci ano. Regulárním
 * výrazem to nejde — `'http://x' // pozn.` má obojí na jednom řádku a naivní
 * `//` matcher by uřízl půlku řetězce.
 *
 * **Regulární literály se přeskakují celé**, protože jinak `//` uvnitř nich
 * spustí režim komentáře a zbytek řádku zmizí. Naměřeno reviewem nad `1c173bc`:
 * `const r = /https:\/\//; const u = 'https://evil-exfil.net/v1';` vrátilo z
 * `hostsIn` prázdno, takže kontroly 5 a 7 nad tím řádkem tvrdily, že je čistý.
 * Tenhle soubor sám takový řádek obsahuje.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;

  // Poslední znak mimo bílé místo a slovo, které mu bezprostředně předchází.
  // Čte se zpětně z už zapsaného výstupu, ne z průběžně udržovaného stavu —
  // ten se u mezer mezi slovem a lomítkem plete.
  const preceding = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k -= 1;
    return { char: j >= 0 ? out[j] : '', word: out.slice(k + 1, j + 1) };
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        const { text, length } = decodeEscapeMarked(source, i);
        out += text;
        i += length;
        continue;
      }
      if (c === quote) quote = null;
      // Skutečný konec řádku uvnitř šablonového literálu je totéž, co `\n` v
      // apostrofech: `fetch` ho z URL zahodí. Musí dostat stejnou značku, jinak
      // by se stejná obcházka napsala o řádek níž a prošla.
      out += c === '\n' || c === '\r' || c === '\t' ? INVISIBLE : c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // Regex se zkouší dřív než `//`, ale `//` samo regex být nemůže (prázdný
    // literál v JS neexistuje), takže se pořadí o komentáře nepřipraví.
    if (c === '/' && next !== '/') {
      const { char, word } = preceding();
      if (REGEX_MAY_FOLLOW.has(char) || REGEX_MAY_FOLLOW_WORD.has(word)) {
        const end = endOfRegex(source, i);
        if (end !== -1) {
          out += source.slice(i, end);
          i = end;
          continue;
        }
      }
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
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

/**
 * URL tak, jak stojí ve zdroji. Třída znaků končí tam, kde v kódu končí literál.
 * `$` a `{` jsou vyloučené schválně: `` `https://${provider}.example/` `` je host
 * složený za běhu a tenhle skript ho vidět nemá — kdyby se přiřadil host `$`,
 * kontrola 5 by hlásila nesmysl místo přiznané mezery.
 *
 * **První alternativa je IPv6 v hranatých závorkách.** Bez ní `https://[2606:4700::1111]/v1`
 * nedalo žádnou shodu — tedy ticho, ne chybu — a kontrola 5 nad tím voláním prošla.
 * Zpětné lomítko se do shody **pouští schválně**, aby se dalo nahlásit: v hostu
 * legitimní escape není a `https://a.io\@zly.net` je přesně ten tvar, který má brána
 * zastavit.
 */
const URL_IN_SOURCE = /https?:\/\/(?:\[[^\]\s"'`]*\][^\s"'`<>(){}[\]$,;\u0001]*|[^\s"'`<>(){}[\]$,;\u0001]+)/gi;

/**
 * Co se z nálezu smí vypsat. Brána běží v git hooku a její výstup jde do
 * terminálu i do CI logu, takže **cesta ani query se netisknou nikdy** — reset
 * token ve cestě nebo `?token=` v query je přesně ten údaj, který by tím unikl.
 * Zbývá schéma a soubor, a to na dohledání stačí.
 */
function safeShape(raw) {
  const scheme = /^https?:/i.exec(raw)?.[0]?.toLowerCase() ?? 'http(s):';
  return `${scheme}//…`;
}

/**
 * Skončila shoda uprostřed autority? Znaková třída končí i na znacích, které
 * v hostu klidně pokračují — `$ , ; ( { [` a `INVISIBLE`. Když se za shodou
 * takový znak objeví a shoda přitom **nedošla ani k první `/` za autoritou**,
 * host se určit nedá a odhadnout ho je horší než to přiznat.
 *
 * Přesně tudy vedly obě cesty, které přežily první remediaci:
 * `'https://api.openai.com\n@evil-exfil.net/v1'` a
 * `'https://api.openai.com$@evil-exfil.net/v1'` obojí vrátilo `api.openai.com`,
 * což je registrovaný host — a `fetch` přitom `\n` z URL zahazuje a jde na
 * `evil-exfil.net`.
 *
 * **Skutečná mezera v sadě není**, a to je ten rozdíl: `'viz https://a.io a dál'`
 * je věta v řetězci, ne useknutá autorita. Rozlišit je jde jen proto, že
 * neviditelné znaky mají po dekódování vlastní značku.
 *
 * `` `https://a.io/${id}` `` taky projde: shoda došla za autoritu, takže se za
 * běhu skládá cesta, ne host.
 */
const AUTHORITY_MAY_CONTINUE = new Set(['$', ',', ';', '(', '{', '[', '@', INVISIBLE]);

function authorityTruncated(stripped, match) {
  const raw = match[0];
  const afterScheme = raw.slice(raw.indexOf('//') + 2);
  if (/[/?#]/.test(afterScheme)) return false;
  if (!AUTHORITY_MAY_CONTINUE.has(stripped[match.index + raw.length] ?? '')) return false;

  // `http://127.0.0.1:${port}` je useknuté v portu, ne v hostu, a ten host je
  // loopback. Hlásit ho by znamenalo nález na každém lokálním serveru v repu —
  // a nález, který se nedá umlčet jinak než `--no-verify`, tlačí přesně tam.
  //
  // **Co se tím vzdává, řečeno nahlas:** `http://127.0.0.1:${x}@zly.net/` tahle
  // výjimka propustí. Je to ale týž případ, který kontrola 5 v hlavičce už
  // přiznává — host složený za běhu nevidí — ne nový ústupek.
  const determinable = afterScheme.slice(afterScheme.lastIndexOf('@') + 1).split(':')[0];
  return !NOT_EXTERNAL.test(determinable);
}

/**
 * Hosty **z rozparsované URL**, ne podřetězcem. Lexikální výřez `[A-Za-z0-9.\-]+`
 * se zastavil na `@`, takže userinfo skryla skutečný cíl: z
 * `https://api.openai.com@evil-exfil.net/v1` vyšel `api.openai.com`, který v
 * registru je, a kontrola 5 zezelenala nad voláním na `evil-exfil.net`.
 *
 * Neparsovatelná URL se **hlásí**, ne zahazuje. Prefix `https?://` už padl, takže
 * co se za ním nedá přečíst, je nález, ne šum.
 */

export function hostsIn(source) {
  const found = new Set();
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(URL_IN_SOURCE)) {
    const raw = match[0].replace(/[.,;:]+$/, '');
    if (raw.includes('\\')) {
      found.add(`${safeShape(raw)} — URL nese zpětné lomítko, host se z ní nedá určit`);
      continue;
    }
    if (authorityTruncated(stripped, match)) {
      found.add(`${safeShape(raw)} — autorita URL pokračuje za koncem literálu, host se nedá určit`);
      continue;
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      found.add(`${safeShape(raw)} — nedá se rozparsovat jako URL`);
      continue;
    }
    // `hostname`, ne `host`: port do disclosure nepatří — `RULES.md` §2 se ptá,
    // na jaké službě to stojí, ne na kterém jejím portu. `NOT_EXTERNAL` na hostu
    // s portem navíc nesedne a loopback by prošel jako externí služba.
    const host = url.hostname.toLowerCase();
    if (!host || NOT_EXTERNAL.test(host)) continue;
    found.add(host);
  }
  return found;
}

/**
 * URL s userinfo (`user@host`, `user:heslo@host`). Je to samostatný nález i tehdy,
 * když je host v registru: v produkčním kódu to buď skrývá skutečný cíl, nebo
 * veze přihlašovací údaj, a obojí má brána zastavit.
 *
 * **Heslo se do výstupu nepíše.** Brána běží v git hooku a její výstup končí v
 * terminálu i v logu; vypsat nalezený údaj by z kontroly udělala druhý únik.
 */
export function credentialUrlsIn(source) {
  const found = new Set();
  for (const match of stripComments(source).matchAll(URL_IN_SOURCE)) {
    const raw = match[0].replace(/[.,;:]+$/, '');
    let url;
    try {
      url = new URL(raw);
    } catch {
      // Nerozparsovatelnou URL hlásí `hostsIn`, a hlásí ji bez cesty a query.
      // Kdyby se sem dopisoval druhý výpis, byl by to druhý průsak téhož údaje.
      continue;
    }
    if (!url.username && !url.password) continue;
    found.add(`${url.protocol}//***@${url.hostname.toLowerCase()}/…`);
  }
  return found;
}

/**
 * Projde produkční kód a sesbírá, co v něm `extract` najde: hodnota → první soubor.
 *
 * Čte se **týmž zdrojem jako registr** — v ověřovacím režimu index, ne pracovní
 * strom. Bez toho zbyla přesně ta obcházka, kterou zbytek souboru zavírá: stagenout
 * soubor s cizím hostem, opravit ho na disku, `git add` zapomenout — a všech sedm
 * kontrol zezelená nad kódem, který se do commitu nedostane.
 *
 * Netrackované soubory se berou taky: `git add -A` je tam za chvíli dostane.
 */
/**
 * Zdroje se čtou **jednou pro všechny extraktory**. Tři nezávislé průchody
 * znamenaly tři `git show` na každý soubor a hook se tím prodloužil z 13 na 21
 * sekund — a hlavička hooku sama píše, že jediná cesta kolem je `--no-verify`,
 * která vypne obě brány. Latence tlačí právě tam, takže je to součást brány.
 */
let sourceCache = null;

function loadSources() {
  if (sourceCache) return sourceCache;
  sourceCache = [];
  for (const shown of codePaths()) {
    let source;
    try {
      source = readTracked(shown);
    } catch {
      // Nepřečtený soubor je neznámý soubor. Mlčky ho přeskočit by znamenalo
      // hlásit „žádný neznámý host" nad kódem, který nikdo nečetl.
      throw new Error(`${shown} se nepodařilo přečíst — kontrola by nad ním tvrdila nepravdu`);
    }
    sourceCache.push([shown, source]);
  }
  return sourceCache;
}

function scanCode(extract) {
  const hits = new Map();
  for (const [shown, source] of loadSources()) {
    for (const value of extract(source)) if (!hits.has(value)) hits.set(value, shown);
  }
  return hits;
}

/** Cesty ke skenovanému kódu: co je v indexu, plus co na disku čeká na `git add`. */
function codePaths() {
  const paths = new Set();
  const wanted = (shown) =>
    CODE_ROOTS.some((root) => shown.startsWith(`${root}/`)) &&
    CODE_FILE.test(shown) &&
    !TEST_FILE.test(shown) &&
    !shown.split('/').some((segment) => CODE_SKIP_DIR.test(segment));

  const tracked = sourceMode === 'index' ? trackedPaths() : null;
  if (tracked) for (const shown of tracked) if (wanted(shown)) paths.add(shown);

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CODE_SKIP_DIR.test(entry.name)) walk(full);
        continue;
      }
      if (!CODE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
      paths.add(relative(REPO, full).split(sep).join(posix.sep));
    }
  };
  for (const root of CODE_ROOTS) walk(join(REPO, root));
  return [...paths].sort((a, b) => a.localeCompare(b));
}

const calledHosts = () => scanCode(hostsIn);
const namedModels = () => scanCode(modelIdsIn);
const credentialUrls = () => scanCode(credentialUrlsIn);

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

/**
 * Assety se **neodvozují**. Cesta v `public/` neříká, kdo soubor vyrobil ani pod
 * jakou licencí — a dřív si tenhle skript dosazoval `worldsmith` / `MIT` na
 * všechno, co tam leželo. Cizí HDRI nebo font shozený do `public/` tím dostal
 * v generovaném `DISCLOSURE.md` nepravdivou licenci a brána nad ním zezelenala;
 * `RULES.md` §2 přitom existuje přesně proti tomuhle.
 *
 * Seznam cest se odvozuje dál (kontrola 4 hlídá obě strany), pole se píšou ručně.
 */

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
  // `--sync` tady nepomůže a nesmí to nabízet: licenci assetu odvodit nejde,
  // položku musí napsat člověk, který ví, odkud ten soubor je.
  if (missing.length) {
    return `${missing.length} assetů není v registru, první: ${missing[0]} (doplň položku ručně, licence se neodvozuje)`;
  }
  if (extra.length) return `${extra.length} položek registru už v public/ není, první: ${extra[0]} (smaž je z registru)`;
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
  //
  // **Obě strany parsují stejně.** Do 17. 8. 2026 tuhle větu plnil jen registr;
  // strana kódu brala host regulárním výrazem, který se zastavil na `@`, takže
  // `https://api.openai.com@evil-exfil.net/v1` se porovnávalo jako `api.openai.com`.
  const known = new Set();
  for (const entry of registry.entries) {
    if (entry.kind !== 'api') continue;
    const source = String(entry.source ?? '').trim();
    try {
      known.add(new URL(source).hostname.toLowerCase());
    } catch {
      // Zdroj, který není URL, se bere jako holý host — jinak by položka mlčky
      // nekryla nic a kontrola by hlásila host, který v registru je.
      known.add(source.toLowerCase());
    }
  }
  const unknown = [];
  // Userinfo je nález sám o sobě, a hlásí se dřív než neznámé hosty: URL, která ho
  // nese, není nedodělaný registr, je to skrytý cíl nebo uniklý údaj.
  for (const [shown, file] of credentialUrls()) {
    unknown.push(`${shown} (${file}) — URL nese userinfo před hostem, to brána nepropustí`);
  }
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
  const tracked = sourceMode === 'index' ? trackedPaths() : null;
  if (!tracked?.has(RENDERED_FILE) && !existsSync(join(REPO, RENDERED_FILE))) {
    return `${RENDERED_FILE} chybí — spusť \`--sync\``;
  }
  const committed = readTracked(RENDERED_FILE);
  const expected = renderDisclosure(registry.entries);
  if (committed === expected) return null;
  return `${RENDERED_FILE} se rozešel s registrem — byl editovaný ručně, nebo se stagenul jen jeden ze dvou souborů? Spusť \`--sync\` a stagene obojí`;
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
  const derived = deriveLibraries().map((entry) => {
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
          'Generováno `node scripts/license-gate.mjs --sync`. library se odvozuje z lockfilu; asset, model, dataset a api se píšou ručně a sync je nechává být.',
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

  // `--sync` právě přepsal disk; kontroly za ním musí číst ten disk, jinak by
  // hlásily stav indexu, tedy obsah před vlastní prací syncu.
  if (argv.includes('--sync')) {
    sourceMode = 'disk';
    sync();
  }

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
