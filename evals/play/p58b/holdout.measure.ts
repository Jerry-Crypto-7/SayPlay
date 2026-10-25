/**
 * P58B T8: zapečetěná sada (80 vět od Codexu, T1) otevřená jednou. Nic se podle výsledku neladí.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p58b/holdout.measure.ts
 * ```
 *
 * Vzor je `p56a/holdout.measure.ts`, čtečka je vybraná astra (T3): `gpt-6-astra` přes OpenAI API, úsilí `low`, cesta
 * AI verze (`PLAY_READER_PATH=ai`, rozpočet 15 s), klíč `OPENAI_API_KEY` z `.env.local` – ven nikdy. Strop čtečky
 * `PLAY_READER_SPEND_CAP_USD` = `CAP_USD`.
 *
 * Pořadí je pevné: zkušební čtení věty mimo sadu (čtečka neodpovídá → konec bez otevření pečeti), `openSealedOnce`
 * zapíše `holdout-opened.json`, čtečka přečte všech 80 vět a čtení se zapíšou do `readings/holdout.astra.json` dřív,
 * než se cokoli spočítá. Pak každá věta jde návrhem se čtením (semínko 1, žánr AI verze rozhoduje čtení – T5, T5a)
 * a robot světa hraje hru, kterou návrh vrátil. Rychlá hra (návrh bez čtení: slovník s pravidlem T5) má bránu
 * žánru a pastí zvlášť (`fast`). Výsledek `final.json`.
 *
 * Cíl trefí, když hraje žánr věty (`genre` bez režimu; režim zvlášť jako `targetMode`). Past projde, když nehraje
 * žánr i režim, kam věta láká (`lure`); přísnější počet bez téhož žánru v libovolném režimu je zvlášť (`trapGenre`).
 * Čtení `null` (vypršelo, strop, chyba) běh zneplatní: `valid: false`, opakuje se na čerstvém procesu.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { readBeforeDraft, readerConfigFromEnv, readerPromptVersion } from '../../../src/play/read/client';
import type { Reading } from '../../../src/play/read/schema';
import { memoryAnswerStore } from '../../../src/server/answer-cache';
import { readerSpendCapFromEnv } from '../../../src/server/spend-cap';

import { castSummary, rowOf, ROOT, type Row } from '../p56a/rows';
import { openSealedOnce, P58B_HOLDOUT_SHA256 } from './seal';

const DIR = join(ROOT, 'p58b');
const SEED = 1;
const MODEL = 'gpt-6-astra';
const CAP_USD = 4;
/** Brány T8; latence čtečky se zapíše, ale neplatí – astra čte jen pro AI verzi (rozhodnutí T3). */
const GATES = { targetGenre: 48, trapOffLure: 18, bot: 80, idleLoses: 80, replayEqual: 80, readerP50Ms: 700, readerP95Ms: 1000 } as const;

interface HoldoutSentence {
  readonly id: string; readonly family: 'target' | 'trap'; readonly genre: string | null; readonly lure: string | null; readonly text: string;
  readonly hero: string | null; readonly foe: string | null; readonly item: string | null; readonly world: string | null;
}

// `@next/env` pod vitestem (`NODE_ENV=test`) `.env.local` vynechá; klíč čtečky je jen tam.
if (existsSync(join(process.cwd(), '.env.local'))) process.loadEnvFile(join(process.cwd(), '.env.local'));
const env: Record<string, string | undefined> = {
  ...process.env,
  PLAY_READER: 'on',
  PLAY_READER_PATH: 'ai',
  PLAY_READER_ENDPOINT: 'openai:https://api.openai.com',
  PLAY_READER_MODEL: MODEL,
  PLAY_READER_KEY: process.env.OPENAI_API_KEY,
  PLAY_READER_EFFORT: 'low',
  PLAY_READER_USD_PER_MTOK_IN: '10',
  PLAY_READER_USD_PER_MTOK_OUT: '50',
  PLAY_READER_SPEND_CAP_USD: String(CAP_USD),
  PLAY_READER_CALL_CAP: '1000',
  PLAY_READER_CALLS_PER_CALLER: '1000',
  KV_REST_API_URL: '',
  KV_REST_API_TOKEN: '',
  WORLDSMITH_SPEND_STORE_URL: '',
  WORLDSMITH_SPEND_STORE_TOKEN: '',
};
// `processReaderSpendCap()` čte `process.env`, ne `env` výše: strop měření se předá výslovně. Bez sdílené knihy
// strop odmítne (`STORE_UNCONFIGURED`); `VERCEL_ENV=production` mu dá knihu procesu – měření je jediný proces.
const cap = readerSpendCapFromEnv({ ...env, VERCEL_ENV: 'production' });
const CALLER = 'p58b-t8-holdout';
const genreOf = (draft: string | null | undefined): string | null => (draft == null ? null : draft.split('.')[0]!);
const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
/** Slovo věty je ve specu, když ho nese popisek (jednotné i množné číslo, obě strany). */
const named = (label: string | null | undefined, word: string | null): boolean | null => {
  if (word === null) return null;
  if (label == null) return false;
  const a = label.toLowerCase();
  const b = word.toLowerCase();
  return a.includes(b) || b.includes(a) || a.includes(b.replace(/s$/, '')) || b.includes(a.replace(/s$/, ''));
};

/** Robot vyhraje, nečinný prohraje a replay sedí – hra se čtením, semínko 1 (jako P56A). */
async function botOf(text: string, reading: Reading | null) {
  try {
    const spec = draftGameSpecWithMeta(text, SEED, { reading }).spec;
    await preloadPhysics(spec, loadRapier);
    const made = arcadeWorldOf(spec, SEED);
    if (!made.ok) return { wins: false, idleLoses: false, replayEqual: false, why: made.issues[0] ?? 'world not built' };
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const wins = verdict.bot.outcome === 'won';
    const idleLoses = verdict.idle.outcome !== 'won';
    return { wins, idleLoses, replayEqual: verdict.replayEqual, why: wins && idleLoses && verdict.replayEqual ? null : (verdict.failures[0] ?? `bot ${verdict.bot.outcome}, idle ${verdict.idle.outcome}`) };
  } catch (error) {
    // Sada se otevírá jednou: pád návrhu je řádek výsledku, ne konec běhu.
    return { wins: false, idleLoses: false, replayEqual: false, why: `draft threw: ${(error as Error).message.slice(0, 160)}` };
  }
}

it('opens the sealed P58B holdout once and writes final.json (T8)', async () => {
  if (!env.PLAY_READER_KEY) throw new Error('OPENAI_API_KEY is missing in .env.local – the seal stays closed');
  const config = readerConfigFromEnv(env);
  if (config === null) throw new Error('the reader is not configured – the seal stays closed');
  const store = memoryAnswerStore();
  // Zkušební věta mimo sadu: bez odpovědi čtečky by se pečeť zlomila naprázdno.
  if ((await readBeforeDraft('a cat catches falling fish on a pier', env, { store: null, caller: CALLER, cap })) === null) throw new Error('the reader did not answer – the seal stays closed');

  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  // Nanečisto (`P58B_T8_DRY=<n>`): n/2 cílů a n/2 pastí z otevřené `p56a/holdout.json`, výstup do dočasné složky, pečeť zůstane.
  const dry = process.env.P58B_T8_DRY === undefined ? null : Number(process.env.P58B_T8_DRY);
  const out = dry === null ? DIR : mkdtempSync(join(tmpdir(), 'p58b-t8-dry-'));
  const bytes = dry === null ? openSealedOnce(DIR, P58B_HOLDOUT_SHA256, commit, 'P58B T8 (holdout.measure.ts)') : readFileSync(join(ROOT, 'p56a', 'holdout.json'), 'utf8');
  const all = (JSON.parse(bytes) as { sentences: HoldoutSentence[] }).sentences;
  const sentences = dry === null ? all : [...all.filter((s) => s.family === 'target').slice(0, dry / 2), ...all.filter((s) => s.family === 'trap').slice(0, dry / 2)];

  const read: { id: string; text: string; ms: number; reading: Reading | null }[] = [];
  for (const sentence of sentences) {
    const started = performance.now();
    const reading = await readBeforeDraft(sentence.text, env, { store, caller: CALLER, cap });
    read.push({ id: sentence.id, text: sentence.text, ms: Math.round(performance.now() - started), reading });
  }
  const ms = read.map((row) => row.ms);
  const readSummary = { n: read.length, valid: read.filter((row) => row.reading !== null).length, p50Ms: quantile(ms, 0.5), p95Ms: quantile(ms, 0.95), maxMs: Math.max(...ms) };
  mkdirSync(join(out, 'readings'), { recursive: true });
  writeFileSync(join(out, 'readings', 'holdout.astra.json'), `${JSON.stringify({
    schema: 'p58b-readings.v1', set: 'evals/play/p58b/holdout.json', model: config.model, transport: config.endpoint, effort: env.PLAY_READER_EFFORT, promptVersion: readerPromptVersion(),
    budgetMs: config.timeoutMs, commit, readAt: new Date().toISOString(), summary: readSummary, readings: read,
  }, null, 2)}\n`);

  await loadRapier();
  const readingOf = (i: number): Reading | null => read[i]!.reading;
  const withRead: Row[] = sentences.map((sentence, i) => rowOf(sentence, readingOf(i)));
  const words: Row[] = sentences.map((sentence) => rowOf(sentence));
  const bots: Awaited<ReturnType<typeof botOf>>[] = [];
  for (const [i, sentence] of sentences.entries()) bots.push(await botOf(sentence.text, readingOf(i)));
  const rows = sentences.map((sentence, i) => {
    const row = withRead[i]!;
    const draft = row.draft;
    const wordsDraft = words[i]!.draft;
    const bot = bots[i]!;
    const hero = 'hero' in row ? row.hero : null;
    const cast = 'cast' in row ? row.cast.map((item) => item.split(':').slice(1).join(':')) : [];
    const readGenre = readingOf(i)?.genre ?? null;
    return {
      id: sentence.id, family: sentence.family, genre: sentence.genre, lure: sentence.lure, draft, wordsDraft,
      readGenre: readGenre === null ? null : `${readGenre.genre}.${readGenre.mode}`,
      genreOk: sentence.family === 'target' ? genreOf(draft) === genreOf(sentence.genre) : draft !== sentence.lure,
      modeOk: sentence.family === 'target' ? draft === sentence.genre : genreOf(draft) !== genreOf(sentence.lure),
      wordsGenreOk: sentence.family === 'target' ? genreOf(wordsDraft) === genreOf(sentence.genre) : wordsDraft !== sentence.lure,
      // Slova věty ve specu (hrdina = hráčova role, protivník a věc = obsazení žánru); viditelnost soudí až snímek.
      spec: { hero: named(hero, sentence.hero), foe: sentence.foe === null ? null : cast.some((label) => named(label, sentence.foe)), item: sentence.item === null ? null : cast.some((label) => named(label, sentence.item)) || named(hero, sentence.item) === true },
      title: 'title' in row ? row.title : null, look: 'look' in row ? row.look : null, world: sentence.world,
      heroLabel: hero, cast,
      bot,
    };
  });

  const targets = rows.filter((row) => row.family === 'target');
  const traps = rows.filter((row) => row.family === 'trap');
  const count = (list: readonly (typeof rows)[number][], ok: (row: (typeof rows)[number]) => boolean) => ({ hit: list.filter(ok).length, of: list.length });
  const said = (key: 'hero' | 'foe' | 'item') => count(rows.filter((row) => row.spec[key] !== null), (row) => row.spec[key] === true);
  const summary = {
    targetGenre: count(targets, (row) => row.genreOk),
    targetMode: count(targets, (row) => row.modeOk),
    targetReadingAlone: count(targets, (row) => genreOf(row.readGenre) === genreOf(row.genre)),
    trapOffLure: count(traps, (row) => row.genreOk),
    trapGenre: count(traps, (row) => row.modeOk),
    trapPlaysItsGenre: count(traps.filter((row) => row.genre !== null), (row) => row.draft === row.genre),
    bot: count(rows, (row) => row.bot.wins),
    idleLoses: count(rows, (row) => row.bot.idleLoses),
    replayEqual: count(rows, (row) => row.bot.replayEqual),
    specNames: { hero: said('hero'), foe: said('foe'), item: said('item') },
    worldMatches: count(rows.filter((row) => row.world !== null), (row) => row.look === row.world),
    cast: castSummary(sentences, withRead),
    reader: readSummary,
    targetMisses: targets.filter((row) => !row.genreOk).map((row) => `${row.id}: ${row.genre} -> ${row.draft ?? 'none'} (reading ${row.readGenre ?? 'none'}, words ${row.wordsDraft ?? 'none'})`),
    trapsOnLure: traps.filter((row) => !row.genreOk).map((row) => `${row.id}: lure ${row.lure} played (reading ${row.readGenre ?? 'none'}, words ${row.wordsDraft ?? 'none'})`),
    botFailures: rows.filter((row) => row.bot.why !== null).map((row) => `${row.id}: ${row.bot.why}`),
  };
  const fast = {
    about: 'fast game: draft without a reading (vocabulary with the T5 rule); the reader is too slow for it (T3)',
    targetGenre: count(targets, (row) => row.wordsGenreOk),
    trapOffLure: count(traps, (row) => row.wordsGenreOk),
    targetMisses: targets.filter((row) => !row.wordsGenreOk).map((row) => `${row.id}: ${row.genre} -> ${row.wordsDraft ?? 'none'}`),
    trapsOnLure: traps.filter((row) => !row.wordsGenreOk).map((row) => `${row.id}: lure ${row.lure} played`),
  };
  const met = {
    targetGenre: summary.targetGenre.hit >= GATES.targetGenre,
    trapOffLure: summary.trapOffLure.hit >= GATES.trapOffLure,
    bot: summary.bot.hit >= GATES.bot,
    idleLoses: summary.idleLoses.hit >= GATES.idleLoses,
    replayEqual: summary.replayEqual.hit >= GATES.replayEqual,
    readerP50Ms: readSummary.p50Ms !== null && readSummary.p50Ms <= GATES.readerP50Ms,
    readerP95Ms: readSummary.p95Ms !== null && readSummary.p95Ms <= GATES.readerP95Ms,
    fastTargetGenre: fast.targetGenre.hit >= GATES.targetGenre,
    fastTrapOffLure: fast.trapOffLure.hit >= GATES.trapOffLure,
  };
  const valid = readSummary.valid === readSummary.n;
  writeFileSync(join(out, 'final.json'), `${JSON.stringify({ schema: 'p58b-final.v1', commit, sha256: P58B_HOLDOUT_SHA256, model: MODEL, transport: config.endpoint, effort: env.PLAY_READER_EFFORT, capUsd: CAP_USD, seed: SEED, valid, invalid: valid ? null : `${readSummary.n - readSummary.valid} readings null – repeat on a fresh process`, holdout: { gates: GATES, met, summary, fast, rows } }, null, 1)}\n`);
  console.log(`valid ${valid} · targets ${summary.targetGenre.hit}/60 (mode ${summary.targetMode.hit}) · traps off lure ${summary.trapOffLure.hit}/20 · fast ${fast.targetGenre.hit}/60 ${fast.trapOffLure.hit}/20 · bot ${summary.bot.hit}/80 · idle loses ${summary.idleLoses.hit}/80 · replay ${summary.replayEqual.hit}/80 · read ${readSummary.valid}/80 p50 ${readSummary.p50Ms} ms p95 ${readSummary.p95Ms} ms -> ${out}`);
}, 3 * 60 * 60_000);
