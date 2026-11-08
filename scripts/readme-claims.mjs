#!/usr/bin/env node
/**
 * Každé číslo v README a v textech přihlášky ukazuje na měření v repu (P79 T1).
 *
 * ```
 * node scripts/readme-claims.mjs     exit 0 = všechno sedí, 1 = aspoň jeden nález
 * ```
 *
 * Hodnotitel – člověk i AI, která čte repozitář – si má každé tvrzení ověřit
 * odkazem. Proto dvě pravidla nad `README.md` a nad popisem a průvodcem
 * z `docs/submission/submission.json`:
 *
 * 1. **Číslo bez zdroje shodí kontrolu.** Každé naměřené číslo v textu musí
 *    stát ve sloupci `Numbers` tabulky v `evals/play/p79/claims.md`. Řádek té
 *    tabulky nese datum, soubor v repu a doslovný úryvek (`Evidence`), který
 *    v tom souboru je. Řádek bez souboru, se souborem mimo repo nebo s úryvkem,
 *    který v souboru není, je nález.
 * 2. **Mrtvý odkaz shodí kontrolu.** Relativní odkaz musí vést na soubor, který
 *    bude ve veřejném repu (sledovaný, nebo nový a ne gitignorovaný), a kotva
 *    `#…` na nadpis, který v cílovém markdownu je.
 *
 * Co je „naměřené číslo“, rozhoduje `measuredNumbers()`: zlomek (`200/200`,
 * `11 of 12`), rozsah (`45–60`), desetinné číslo, číslo s jednotkou času,
 * snímků, peněz nebo procent, a celé číslo od 100 výš, které není rok.
 * simplified: holé malé celé číslo bez jednotky („4 seeds“, „60 Hz“) se
 * nekontroluje – jsou to vlastnosti kódu, ne měření; kdyby README začalo
 * tvrdit malá čísla jako výsledky, patří jim jednotka do `UNIT`.
 *
 * Úryvek se hledá doslova a vazbu čísla na úryvek posuzuje člověk, který
 * řádek píše: kontrola ručí za to, že důkaz v repu je, ne že ho čte správně.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLAIMS_FILE = 'evals/play/p79/claims.md';
export const README_FILE = 'README.md';
const MANIFEST_FILE = 'docs/submission/submission.json';

/** Jednotky, se kterými je i malé celé číslo tvrzení o měření. */
const UNIT = /^(?:%|ms|s|min|FPS|fps|USD|MB|kB|KB)$/;

/**
 * Jedno číslo, nebo dvojice spojená lomítkem, „of“ / „out of“ nebo pomlčkou.
 * Před ním nesmí stát znak, který z něj dělá kus jména (`P74`, `TRELLIS.2`,
 * `gpt-6`, `#113`, `12:00`); za ním písmeno (`3D`, `4B`) ani další kus data.
 */
const NUMBER =
  /(?<![\p{L}\p{N}_.,/:#–-])(\d+(?:\.\d+)?)(?:(\s?\/\s?|\s(?:out\s)?of\s|\s?[–-]\s?)(\d+(?:\.\d+)?))?(?![\p{L}\p{N}_]|[.,/:–-]\d)(?:\s?(%|[A-Za-z]+))?/gu;

/**
 * Text, ve kterém se hledají čísla: bez bloků kódu, komentářů, kódu v řádku,
 * cílů odkazů a holých adres. Počet řádků zůstává, aby nález nesl číslo řádku.
 */
function proseLines(markdown) {
  const keepLines = (match) => match.replace(/[^\n]/g, ' ');
  return markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, keepLines)
    .replace(/<!--[\s\S]*?-->/g, keepLines)
    .split('\n')
    .map((line) =>
      line
        .replace(/`[^`]*`/g, ' ')
        .replace(/\]\([^)]*\)/g, '] ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' '),
    );
}

/** Klíč, pod kterým se číslo porovnává s tabulkou: bez mezer, „of“ = lomítko. */
function keyOf(first, joiner, second) {
  if (second === undefined) return first;
  const join = joiner.trim() === '/' || /of/.test(joiner) ? '/' : '–';
  return `${first}${join}${second}`;
}

/**
 * Naměřená čísla v markdownu: `{ key, text, line }`. Klíč je to, co musí stát
 * v `claims.md`; `text` je doslovný tvar pro hlášku.
 */
export function measuredNumbers(markdown) {
  const found = [];
  proseLines(markdown).forEach((line, index) => {
    for (const match of line.matchAll(NUMBER)) {
      const [text, first, joiner, second, unit] = match;
      const hasUnit = unit !== undefined && UNIT.test(unit);
      const whole = Number(first);
      const measured =
        second !== undefined
        || first.includes('.')
        || hasUnit
        || (whole >= 100 && !(second === undefined && whole >= 1900 && whole <= 2099));
      if (measured) found.push({ key: keyOf(first, joiner, second), text: text.trim(), line: index + 1 });
    }
  });
  return found;
}

/**
 * Buňky jednoho řádku tabulky; `null`, když řádek není řádek tabulky. `\|` je
 * svislítko uvnitř buňky (důkaz z markdownové tabulky), ne hranice buněk.
 */
function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed
    .replace(/^\||(?<!\\)\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * Řádky tabulky tvrzení. Hlavička musí mít sloupce `Numbers`, `Date`, `File`
 * a `Evidence`; ostatní sloupce (`ID`, `Claim`) jsou pro čtenáře.
 */
export function parseClaims(markdown) {
  const claims = [];
  let header = null;
  markdown.split('\n').forEach((line, index) => {
    const row = cells(line);
    if (!row) {
      header = null;
      return;
    }
    if (row.every((cell) => /^:?-{3,}:?$/.test(cell))) return;
    if (!header) {
      if (row.includes('Numbers') && row.includes('File') && row.includes('Evidence')) header = row;
      return;
    }
    const field = (name) => row[header.indexOf(name)] ?? '';
    const id = field('ID') || `řádek ${index + 1}`;
    const file = (field('File').match(/`([^`]+)`/)?.[1] ?? field('File')).trim();
    claims.push({
      id,
      line: index + 1,
      keys: new Set(measuredNumbers(field('Numbers')).map(({ key }) => key)),
      date: field('Date'),
      file,
      evidence: [...field('Evidence').matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    });
  });
  return claims;
}

/** Slug nadpisu tak, jak ho počítá GitHub, s `-1`, `-2` pro opakované nadpisy. */
export function headingSlugs(markdown) {
  const slugs = new Set();
  const seen = new Map();
  const text = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  for (const match of text.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/`/g, '')
      .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

/** Cíle relativních odkazů a obrázků: `{ target, line }`. */
export function linkTargets(markdown) {
  const found = [];
  const text = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => block.replace(/[^\n]/g, ' '));
  text.split('\n').forEach((line, index) => {
    const targets = [
      ...[...line.replace(/`[^`]*`/g, ' ').matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
      ...[...line.matchAll(/^\s{0,3}\[[^\]]+]:\s*(\S+)/g)].map((m) => m[1]),
      ...[...line.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ];
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      found.push({ target, line: index + 1 });
    }
  });
  return found;
}

/**
 * Nálezy v jednom dokumentu. Čisté: soubory čte přes `read(path)` a o tom, co
 * bude ve veřejném repu, se ptá `isPublic(path)`; obojí s cestou od kořene repa.
 */
export function documentProblems({ path, text, claimKeys, isPublic, read }) {
  const problems = [];
  for (const { key, text: shown, line } of measuredNumbers(text)) {
    if (!claimKeys.has(key)) problems.push(`${path}:${line} číslo „${shown}“ nemá řádek v ${CLAIMS_FILE}`);
  }

  const here = posix.dirname(path);
  for (const { target, line } of linkTargets(text)) {
    const [rawPath, anchor] = target.split('#');
    const decoded = decodeURI(rawPath);
    const resolved = decoded === ''
      ? path
      : posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(here, decoded)).replace(/\/$/, '');
    if (resolved.startsWith('..') || !isPublic(resolved)) {
      problems.push(`${path}:${line} odkaz „${target}“ vede na ${resolved}, který ve veřejném repu není`);
      continue;
    }
    if (anchor && resolved.endsWith('.md') && !headingSlugs(read(resolved)).has(anchor)) {
      problems.push(`${path}:${line} odkaz „${target}“: v ${resolved} není nadpis #${anchor}`);
    }
  }
  return problems;
}

/** Nálezy v tabulce tvrzení: soubor, datum a doslovný důkaz u každého řádku. */
export function claimRowProblems(claims, { isPublic, read }) {
  const problems = [];
  if (claims.length === 0) problems.push(`${CLAIMS_FILE} nemá tabulku se sloupci Numbers, Date, File a Evidence`);
  for (const claim of claims) {
    const where = `${CLAIMS_FILE}:${claim.line} ${claim.id}`;
    if (!/\b\d{4}-\d{2}-\d{2}\b/.test(claim.date)) problems.push(`${where}: chybí datum měření (RRRR-MM-DD)`);
    if (claim.file === '') {
      problems.push(`${where}: tvrzení bez souboru – vypadne, nebo dostane zdroj`);
      continue;
    }
    if (!isPublic(claim.file)) {
      problems.push(`${where}: ${claim.file} ve veřejném repu není (chybí, nebo je gitignorovaný)`);
      continue;
    }
    if (claim.evidence.length === 0) {
      problems.push(`${where}: chybí doslovný důkaz ve sloupci Evidence`);
      continue;
    }
    const source = read(claim.file);
    for (const literal of claim.evidence) {
      if (!source.includes(literal)) problems.push(`${where}: „${literal}“ v ${claim.file} není`);
    }
  }
  return problems;
}

/**
 * Soubory, které budou ve veřejném repu: sledované a nové negitignorované.
 * Adresář je veřejný, když je veřejný aspoň jeden soubor pod ním.
 */
function publicSet(repo) {
  const files = execFileSync('git', ['--no-replace-objects', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => existsSync(join(repo, file)));
  const all = new Set(files);
  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) all.add(dir);
  }
  return all;
}

/** Dokumenty, které kontrola čte: README a popis s průvodcem z manifestu. */
export function claimDocuments(repo) {
  const docs = [README_FILE];
  const manifestPath = join(repo, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return docs;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const field of ['descriptionPath', 'walkthroughPath']) {
    const path = manifest[field];
    // Chybějící popis hlásí kontrola 4 v `submission-check.mjs`; tady by to byl
    // druhý nález téže vady.
    if (typeof path === 'string' && !path.startsWith('TODO:') && existsSync(join(repo, path))) docs.push(path);
  }
  return docs;
}

/** Všechny nálezy nad stromem `repo`. Prázdné pole = všechno sedí. */
export function claimProblems(repo) {
  const visible = publicSet(repo);
  const isPublic = (path) => visible.has(path);
  const read = (path) => readFileSync(join(repo, path), 'utf8');

  if (!isPublic(CLAIMS_FILE)) return [`${CLAIMS_FILE} chybí – čísla v README nemají odkud brát zdroj`];
  const claims = parseClaims(read(CLAIMS_FILE));
  const problems = claimRowProblems(claims, { isPublic, read });
  const claimKeys = new Set(claims.flatMap((claim) => [...claim.keys]));

  for (const path of claimDocuments(repo)) {
    if (!isPublic(path)) {
      problems.push(`${path} ve veřejném repu není`);
      continue;
    }
    problems.push(...documentProblems({ path, text: read(path), claimKeys, isPublic, read }));
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = claimProblems(process.cwd());
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  console.log(problems.length === 0 ? 'readme-claims: každé číslo má měření, žádný mrtvý odkaz' : `\n${problems.length} nálezů`);
  process.exit(problems.length === 0 ? 0 : 1);
}
