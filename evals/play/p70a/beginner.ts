/**
 * P70A T1: přežije a vyhraje začátečník? Pro každý hratelný žánr (registr `genre/contract.ts` bez koster a bez
 * `ROUTE_PENDING`) 5 vět z existujících sad × 10 seedů: rychlá hra věty (`draftGameSpecWithMeta(věta, 1)`), svět
 * se seedem (`arcadeWorldOf`), běh bota „začátečník“ (`arcade/beginner-bot.ts`) a pro srovnání vítězného robota
 * (`runBot`). Věta patří žánru, když ho slepý soudce P68 dal jako `best` (nebo ho zapečetěná sada P68R/P68T psala
 * pro tu hru) **a** rychlá hra ji do toho žánru opravdu pošle; bere se prvních 5 v pořadí sad.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p70a/beginner.ts \
 *     --out before [--genres flap,duel] [--seeds 10]
 *
 * Zapíše `evals/play/p70a/<out>.json` (řádky + souhrn) a `<out>.md` (tabulka). Souhrn na žánr:
 * - `firstLifeLostS` – medián sekund do prvního ztraceného života (nebo prohry); běh bez ztráty se počítá horizontem.
 * - `survivalS` – medián sekund do prohry; běh, který neprohrál (výhra nebo horizont), přežil celý horizont (90 s).
 * - `winRate` – podíl výher začátečníka; `perfectWinRate` totéž pro vítězného robota.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBeginner, secondsOf } from '@/play/arcade/beginner-bot';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_LIMITS } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { ROUTE_PENDING } from '@/play/genre/classify';
import { GENRES, GENRE_MODES, type GenreId, type GenreModule } from '@/play/genre/contract';
import { GENRE_MODULES } from '@/play/genre/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const HORIZON_S = secondsOf(ARCADE_LIMITS.maxTicks);
export const SENTENCES_PER_GENRE = 5;
export const SEEDS = 10;

export interface Pick { readonly genre: GenreId; readonly id: string; readonly text: string; readonly labelled: boolean }
export interface Row {
  readonly genre: GenreId;
  readonly id: string;
  readonly seed: number;
  /** Výsledek začátečníka; `error` = svět se nepostavil nebo běh spadl. */
  readonly outcome: 'won' | 'lost' | 'running' | 'error';
  readonly endS: number | null;
  readonly firstLifeLostS: number | null;
  readonly perfect: 'won' | 'lost' | 'running' | 'error';
  readonly error?: string;
}
export interface GenreSummary {
  readonly genre: GenreId;
  readonly sentences: number;
  readonly runs: number;
  readonly errors: number;
  readonly firstLifeLostS: number | null;
  readonly survivalS: number | null;
  readonly winRate: number | null;
  readonly perfectWinRate: number | null;
}

/** Žánry, které rychlá hra může dát: ne kostra (`staged` ve všech režimech) a ne brána aktivace. */
export function playableGenres(): GenreId[] {
  return GENRES.filter((genre) => !ROUTE_PENDING.has(genre) && (GENRE_MODES[genre] as readonly string[]).some((mode) => (GENRE_MODULES[genre] as GenreModule).availability(mode as never) !== 'staged'));
}

interface Labelled { readonly text: string; readonly best: string; readonly sets: readonly { readonly set: string; readonly id: string }[] }
interface Sealed { readonly id: string; readonly genre: string | null; readonly text: string }

/**
 * Kandidáti v pořadí: štítky P68 (sada 200 + otevřené sady), pak otevřené zapečetěné sady P68R, P68T, P54C a P66
 * (`genre` = hra, pro kterou byla věta psaná; P54C a P66 doplní flap, crowd a merge, kterých je ve štítcích málo).
 */
function candidates(): { readonly id: string; readonly text: string; readonly genre: string }[] {
  const json = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
  const labels = json<{ sentences: Labelled[] }>('evals/play/p68/genre-labels.json').sentences
    .map((row) => ({ id: `${row.sets[0]?.set ?? 'p68'}#${row.sets[0]?.id ?? '?'}`, text: row.text, genre: row.best }));
  const sealed = (set: string): { id: string; text: string; genre: string }[] =>
    json<{ sentences: Sealed[] }>(`evals/play/${set}`).sentences.map((row) => ({ id: `${set}#${row.id}`, text: row.text, genre: row.genre ?? 'none' }));
  return [...labels, ...['p68r/holdout.json', 'p68t/holdout.json', 'p54c/holdout.json', 'p66/holdout.json'].flatMap(sealed)];
}

const drafted = new Map<string, string | null>();
const draftGenre = (text: string): string | null => {
  if (!drafted.has(text)) {
    try {
      drafted.set(text, draftGameSpecWithMeta(text, 1).genre?.genre ?? null);
    } catch {
      drafted.set(text, null);
    }
  }
  return drafted.get(text) ?? null;
};

/**
 * Prvních `SENTENCES_PER_GENRE` vět žánru, které mu soudce dal a rychlá hra do něj opravdu pošle (`labelled`);
 * chybí-li, doplní je věty jiného štítku, které rychlá hra do žánru pošle taky.
 */
export function pickSentences(genres: readonly GenreId[]): Pick[] {
  const pool = candidates();
  const seen = new Set<string>();
  return genres.flatMap((genre) => {
    const picked: Pick[] = [];
    for (const labelled of [true, false]) {
      for (const row of pool) {
        if (picked.length >= SENTENCES_PER_GENRE) break;
        const key = row.text.trim().toLowerCase();
        if ((labelled && row.genre !== genre) || seen.has(key) || draftGenre(row.text) !== genre) continue;
        seen.add(key);
        picked.push({ genre, id: row.id, text: row.text, labelled });
      }
    }
    return picked;
  });
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 160);

export function measure(picks: readonly Pick[], seeds: number): Row[] {
  const rows: Row[] = [];
  for (const pick of picks) {
    const spec = draftGameSpecWithMeta(pick.text, 1).spec;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const base = { genre: pick.genre, id: pick.id, seed };
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) {
        rows.push({ ...base, outcome: 'error', endS: null, firstLifeLostS: null, perfect: 'error', error: made.issues.join('; ').slice(0, 160) });
        continue;
      }
      try {
        const run = runBeginner(made.world, undefined, { seed });
        const perfect = runBot(made.world).outcome;
        rows.push({ ...base, outcome: run.outcome, endS: secondsOf(run.tick), firstLifeLostS: run.firstLifeLostTick === null ? null : secondsOf(run.firstLifeLostTick), perfect });
      } catch (error) {
        rows.push({ ...base, outcome: 'error', endS: null, firstLifeLostS: null, perfect: 'error', error: message(error) });
      }
    }
  }
  return rows;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const round = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);

/** Souhrn žánru ze surových řádků; běh s chybou do mediánů ani podílů nejde, jen do `errors`. */
export function summarize(rows: readonly Row[], genres: readonly GenreId[]): GenreSummary[] {
  return genres.map((genre) => {
    const all = rows.filter((row) => row.genre === genre);
    const ran = all.filter((row) => row.outcome !== 'error');
    const perfect = all.filter((row) => row.perfect !== 'error');
    return {
      genre,
      sentences: new Set(all.map((row) => row.id)).size,
      runs: all.length,
      errors: all.length - ran.length,
      firstLifeLostS: round(median(ran.map((row) => row.firstLifeLostS ?? HORIZON_S))),
      survivalS: round(median(ran.map((row) => (row.outcome === 'lost' ? (row.endS as number) : HORIZON_S)))),
      winRate: ran.length === 0 ? null : round(ran.filter((row) => row.outcome === 'won').length / ran.length),
      perfectWinRate: perfect.length === 0 ? null : round(perfect.filter((row) => row.perfect === 'won').length / perfect.length),
    };
  });
}

const cell = (value: number | null, suffix = ''): string => (value === null ? '–' : `${String(value)}${suffix}`);

export function table(summary: readonly GenreSummary[]): string {
  const lines = ['| Žánr | Věty | Běhy | Chyby | 1. život (s) | Přežití (s) | Výhry začátečník | Výhry robot |', '|---|---|---|---|---|---|---|---|'];
  for (const row of summary) {
    const pct = (value: number | null): string => (value === null ? '–' : `${String(Math.round(value * 100))} %`);
    lines.push(`| ${row.genre} | ${String(row.sentences)} | ${String(row.runs)} | ${String(row.errors)} | ${cell(row.firstLifeLostS)} | ${cell(row.survivalS)} | ${pct(row.winRate)} | ${pct(row.perfectWinRate)} |`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const out = flag('--out') ?? 'before';
  const seeds = Number(flag('--seeds') ?? SEEDS);
  const only = flag('--genres')?.split(',') ?? null;
  const genres = playableGenres().filter((genre) => only === null || only.includes(genre));
  await loadRapier();
  const started = Date.now();
  const picks = pickSentences(genres);
  const rows = measure(picks, seeds);
  const summary = summarize(rows, genres);
  const commit = flag('--commit') ?? null;
  const doc = {
    schema: 'p70a-beginner.v1',
    commit,
    measuredAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    about: 'Beginner bot (src/play/arcade/beginner-bot.ts: 350-500 ms reaction, 20 % of 250 ms windows missed or wrong control, pure-rand seed) on the quick game of 5 sentences per playable genre x seeds 1..N; perfect = runBot on the same world. firstLifeLostS and survivalS are medians; a run that never lost a life / never lost counts as the 90 s horizon.',
    horizonS: HORIZON_S,
    seeds,
    picks,
    summary,
    rows,
  };
  writeFileSync(join(HERE, `${out}.json`), `${JSON.stringify(doc, null, 1)}\n`);
  writeFileSync(join(HERE, `${out}.md`), `# P70A – začátečník (${out})\n\nCommit ${commit ?? '?'}, ${String(seeds)} seedů, horizont ${String(HORIZON_S)} s. Přepočet ze surových řádků: \`__tests__/beginner.test.ts\`.\n\n${table(summary)}\n`);
  process.stdout.write(`${table(summary)}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
