/**
 * P70A T4, AC 2: verdikt běhu do `result.md`, přepočtený ze surových souborů, ne opsaný:
 * - `before.json` / `after.json` (T1 / T3) – souhrn začátečníka na žánr, tabulka žánr × (před, po);
 * - `chains-before.json` / `chains-after.json` (T2) – podíl řetězců na rychlé cestě;
 * - `browser.json` (T4, `browser.spec.ts`) – šest vět v prohlížeči, průchod 400 ms pozdě.
 *
 *   node --experimental-strip-types --no-warnings evals/play/p70a/result.ts
 *
 * `__tests__/result.test.ts` hlídá, že `result.md` je přesně `render()` těch souborů.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GenreSummary } from './beginner';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Žánr splní cíl začátečníka: medián přežití ≥ 20 s a vyhraje aspoň polovinu běhů. */
export const SURVIVE_S = 20;
export const WIN_SHARE = 0.5;

export interface Shares { readonly sentences: number; readonly chains: number; readonly share: number; readonly withoutCue: number }
export interface BrowserRow {
  readonly id: string;
  readonly text: string;
  readonly genre: string;
  readonly chain: boolean;
  readonly outcome: string;
  readonly endS: number;
  readonly firstLifeLostS: number | null;
  readonly lostOn: 'lives' | 'clock-or-goal' | null;
  readonly survived20: boolean;
  readonly shots: readonly string[];
}
export interface Inputs {
  readonly before: { readonly commit: string | null; readonly summary: readonly GenreSummary[] };
  readonly after: { readonly commit: string | null; readonly summary: readonly GenreSummary[] };
  readonly chainsBefore: { readonly all: Shares };
  readonly chainsAfter: { readonly all: Shares };
  readonly browser: { readonly lagMs: number; readonly viewport: string; readonly rows: readonly BrowserRow[] };
}

export const passes = (row: GenreSummary): boolean => (row.survivalS ?? 0) >= SURVIVE_S && (row.winRate ?? 0) >= WIN_SHARE;

const pct = (value: number | null): string => (value === null ? '–' : `${String(Math.round(value * 100))} %`);
const num = (value: number | null): string => (value === null ? '–' : String(value));
const mark = (ok: boolean): string => (ok ? 'ano' : 'ne');

/** Tabulka žánr × (před, po): přežití, výhry začátečníka, výhry robota po a zda žánr splní cíl. */
export function compare(before: readonly GenreSummary[], after: readonly GenreSummary[]): string {
  const lines = ['| Žánr | Přežití před (s) | Přežití po (s) | Výhry před | Výhry po | Robot po | Cíl před | Cíl po |', '|---|---|---|---|---|---|---|---|'];
  for (const now of after) {
    const was = before.find((row) => row.genre === now.genre);
    lines.push(`| ${now.genre} | ${num(was?.survivalS ?? null)} | ${num(now.survivalS)} | ${pct(was?.winRate ?? null)} | ${pct(now.winRate)} | ${pct(now.perfectWinRate)} | ${was === undefined ? '–' : mark(passes(was))} | ${mark(passes(now))} |`);
  }
  return lines.join('\n');
}

/** Žánry, které cíl po změnách nesplní, a proč – z čísel souhrnu. */
export function exceptions(after: readonly GenreSummary[]): string[] {
  return after.filter((row) => !passes(row)).map((row) => {
    const why = (row.survivalS ?? 0) < SURVIVE_S
      ? `prohraje do ${String(SURVIVE_S)} s (medián ${num(row.survivalS)} s, první život ztratí v ${num(row.firstLifeLostS)} s)`
      : `přežije (medián ${num(row.survivalS)} s), ale vyhraje jen ${pct(row.winRate)}`;
    return `- **${row.genre}** – ${why}`;
  });
}

const LOST_ON: Readonly<Record<string, string>> = { lives: 'došly životy', 'clock-or-goal': 'čas nebo cíl, život neztratil' };

export function browserTable(rows: readonly BrowserRow[]): string {
  const lines = ['| Věta | Žánr | Jedna hra | Konec | Čas (s) | 1. život (s) | Prohra na | ≥ 20 s |', '|---|---|---|---|---|---|---|---|'];
  for (const row of rows) {
    lines.push(`| ${row.text} | ${row.genre} | ${mark(!row.chain)} | ${row.outcome} | ${String(row.endS)} | ${num(row.firstLifeLostS)} | ${row.lostOn === null ? '–' : LOST_ON[row.lostOn]!} | ${mark(row.survived20)} |`);
  }
  return lines.join('\n');
}

const share = (all: Shares): string => `${String(all.chains)}/${String(all.sentences)}`;

export function render(inputs: Inputs): string {
  const { before, after, chainsBefore, chainsAfter, browser } = inputs;
  const total = after.summary.length;
  const passedBefore = before.summary.filter(passes).length;
  const passedAfter = after.summary.filter(passes).length;
  const single = browser.rows.filter((row) => !row.chain).length;
  const survived = browser.rows.filter((row) => row.survived20).length;
  const robotMin = Math.min(...after.summary.map((row) => row.perfectWinRate ?? 0));
  const short = browser.rows.filter((row) => !row.survived20);
  return [
    '# P70A – verdikt: jedna hra na větu a obtížnost',
    '',
    `Přepočteno ze surových souborů (\`result.ts\`, test \`__tests__/result.test.ts\`). Začátečník před: commit ${before.commit ?? '?'}, po: commit ${after.commit ?? '?'}.`,
    '',
    '## Verdikt',
    '',
    `- **Jedna hra na větu – ${chainsAfter.all.chains === 0 && single === browser.rows.length ? 'splněno' : 'nesplněno'}.** Řetězce na rychlé cestě ${share(chainsBefore.all)} před → ${share(chainsAfter.all)} po. V prohlížeči ${String(single)}/${String(browser.rows.length)} vět dalo jednu hru.`,
    `- **Začátečník vyhraje – ${passedAfter === total ? 'splněno' : 'nesplněno'}.** Žánry, kde přežije ≥ ${String(SURVIVE_S)} s a vyhraje ≥ ${String(Math.round(WIN_SHARE * 100))} %: ${String(passedBefore)}/${String(total)} před → ${String(passedAfter)}/${String(total)} po. Vítězný robot vyhraje nejméně ${pct(robotMin)} v každém žánru.`,
    `- **Prohlížeč, hráč o ${String(browser.lagMs)} ms pozdě (${browser.viewport}):** ${String(survived)}/${String(browser.rows.length)} vět přežije ${String(SURVIVE_S)} s.${short.length === 0 ? '' : ` Ne: ${short.map((row) => `${row.genre} (${String(row.endS)} s)`).join(', ')}.`}`,
    '',
    '**Odhad (inference):** ochrana prvních 3 s (T3) začátečníkovi nepomohla, protože neprohrává na začátku. Prohrává později – na odpočtu, na cílovém skóre a v úzkých oknech načasování (flap, rytmus, timing). Další krok musí měnit obtížnost samotnou: delší čas, nižší cílové skóre, širší okna pro stisk.',
    '',
    '## Žánry před a po',
    '',
    compare(before.summary, after.summary),
    '',
    '## Výjimky po změnách',
    '',
    ...exceptions(after.summary),
    '',
    '## Prohlížeč – šest vět',
    '',
    `Snímky v \`shots/\` (karta, 20. sekunda, konec). Průchod: \`browser.spec.ts\`.`,
    '',
    browserTable(browser.rows),
    '',
  ].join('\n');
}

export function readInputs(dir: string = HERE): Inputs {
  const json = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
  return {
    before: json('before.json'),
    after: json('after.json'),
    chainsBefore: json('chains-before.json'),
    chainsAfter: json('chains-after.json'),
    browser: json('browser.json'),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  writeFileSync(join(HERE, 'result.md'), render(readInputs()));
}
