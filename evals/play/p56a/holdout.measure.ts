/**
 * P56A T13: zapečetěná sada (80 vět nezávislého autora, T2) otevřená jednou. Nic se podle výsledku neladí.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p56a/holdout.measure.ts
 * ```
 *
 * Pořadí je pevné: zkušební čtení věty mimo sadu (čtečka neodpovídá → konec bez otevření pečeti), `openSealedOnce`
 * (`seal.ts`) zapíše `holdout-opened.json`, čtečka přečte všech 80 vět týmž transportem jako rychlá cesta
 * (`readBeforeDraft`, výchozí `llamacpp:http://127.0.0.1:8792`, gpt-oss-20b, rozpočet 60 s jako T4/T12) a čtení se
 * zapíšou do `readings/holdout.gpt-oss-20b.json` dřív, než se cokoli spočítá. Pak každá věta jde návrhem se čtením
 * (semínko 1) a robot světa hraje hru, kterou návrh vrátil. Výsledek `final.json` (`holdout`); viditelnost ze snímků
 * (`visible.mjs`) a latence A,B,A,B (`latency.mjs`) do něj přidá T13 další klíče.
 *
 * Cíl trefí, když hraje žánr věty (`genre` bez režimu; režim zvlášť jako `targetMode`). Past projde, když nehraje
 * žánr i režim, kam věta láká (`lure`); přísnější počet bez téhož žánru v libovolném režimu je zvlášť (`trapGenre`).
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { readBeforeDraft, readerConfigFromEnv, readerPromptVersion } from '../../../src/play/read/client';
import type { Reading } from '../../../src/play/read/schema';
import { memoryAnswerStore } from '../../../src/server/answer-cache';

import { castSummary, rowOf, ROOT, type Row } from './rows';
import { openSealedOnce, P56A_HOLDOUT_SHA256 } from './seal';

const DIR = join(ROOT, 'p56a');
const SEED = 1;
const MODEL = 'gpt-oss-20b';
const ENDPOINT = process.env.P56A_READER_ENDPOINT ?? 'llamacpp:http://127.0.0.1:8792';
/** Brány T13. */
const GATES = { targetGenre: 48, trapOffLure: 19, bot: 80, idleLoses: 80, replayEqual: 80 } as const;

interface HoldoutSentence {
  readonly id: string; readonly family: 'target' | 'trap'; readonly genre: string | null; readonly lure: string | null; readonly text: string;
  readonly hero: string | null; readonly foe: string | null; readonly item: string | null; readonly world: string | null;
}

const env: Record<string, string | undefined> = { ...process.env, PLAY_READER: 'on', PLAY_READER_ENDPOINT: ENDPOINT, PLAY_READER_BUDGET_MS: '60000', PLAY_READER_MODEL: MODEL };
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

/** Robot vyhraje, nečinný prohraje a replay sedí – hra se čtením, semínko 1 (jako `dev.measure.ts`). */
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

it('opens the sealed P56A holdout once and writes final.json (T13)', async () => {
  const config = readerConfigFromEnv(env);
  if (config === null) throw new Error(`the reader is not configured for ${ENDPOINT}`);
  const store = memoryAnswerStore();
  // Zkušební věta mimo sadu: bez odpovědi čtečky by se pečeť zlomila naprázdno.
  if ((await readBeforeDraft('a cat catches falling fish on a pier', env, { store: null })) === null) throw new Error(`the reader at ${ENDPOINT} did not answer – the seal stays closed`);

  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const bytes = openSealedOnce(DIR, P56A_HOLDOUT_SHA256, commit, 'P56A T13 (holdout.measure.ts)');
  const sentences = (JSON.parse(bytes) as { sentences: HoldoutSentence[] }).sentences;

  const read: { id: string; text: string; ms: number; reading: Reading | null }[] = [];
  for (const sentence of sentences) {
    const started = performance.now();
    const reading = await readBeforeDraft(sentence.text, env, { store });
    read.push({ id: sentence.id, text: sentence.text, ms: Math.round(performance.now() - started), reading });
  }
  const ms = read.map((row) => row.ms);
  const readSummary = { n: read.length, valid: read.filter((row) => row.reading !== null).length, p50Ms: quantile(ms, 0.5), p95Ms: quantile(ms, 0.95), maxMs: Math.max(...ms) };
  writeFileSync(join(DIR, 'readings', `holdout.${MODEL}.json`), `${JSON.stringify({
    schema: 'p56a-readings.v1', set: 'evals/play/p56a/holdout.json', model: config.model, transport: config.endpoint, promptVersion: readerPromptVersion(),
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
    const bot = bots[i]!;
    const hero = 'hero' in row ? row.hero : null;
    const cast = 'cast' in row ? row.cast.map((item) => item.split(':').slice(1).join(':')) : [];
    const readGenre = readingOf(i)?.genre ?? null;
    return {
      id: sentence.id, family: sentence.family, genre: sentence.genre, lure: sentence.lure, draft, wordsDraft: words[i]!.draft,
      readGenre: readGenre === null ? null : `${readGenre.genre}.${readGenre.mode}`,
      genreOk: sentence.family === 'target' ? genreOf(draft) === genreOf(sentence.genre) : draft !== sentence.lure,
      modeOk: sentence.family === 'target' ? draft === sentence.genre : genreOf(draft) !== genreOf(sentence.lure),
      // Slova věty ve specu (hrdina = hráčova role, protivník a věc = obsazení žánru); viditelnost soudí až snímek.
      spec: { hero: named(hero, sentence.hero), foe: sentence.foe === null ? null : cast.some((label) => named(label, sentence.foe)), item: sentence.item === null ? null : cast.some((label) => named(label, sentence.item)) || named(hero, sentence.item) === true },
      title: 'title' in row ? row.title : null, look: 'look' in row ? row.look : null, world: sentence.world,
      heroLabel: hero, heroLevel: 'heroLevel' in row ? row.heroLevel : null, cast,
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
    targetWordsAlone: count(targets, (row) => genreOf(row.wordsDraft) === genreOf(row.genre)),
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
  const met = {
    targetGenre: summary.targetGenre.hit >= GATES.targetGenre,
    trapOffLure: summary.trapOffLure.hit >= GATES.trapOffLure,
    bot: summary.bot.hit >= GATES.bot,
    idleLoses: summary.idleLoses.hit >= GATES.idleLoses,
    replayEqual: summary.replayEqual.hit >= GATES.replayEqual,
  };
  writeFileSync(join(DIR, 'final.json'), `${JSON.stringify({ schema: 'p56a-final.v1', commit, sha256: P56A_HOLDOUT_SHA256, model: MODEL, transport: config.endpoint, seed: SEED, holdout: { gates: GATES, met, summary, rows } }, null, 1)}\n`);
  console.log(`targets ${summary.targetGenre.hit}/60 (mode ${summary.targetMode.hit}) · traps off lure ${summary.trapOffLure.hit}/20 · bot ${summary.bot.hit}/80 · idle loses ${summary.idleLoses.hit}/80 · replay ${summary.replayEqual.hit}/80 · read ${readSummary.valid}/80 p50 ${readSummary.p50Ms} ms`);
}, 3 * 60 * 60_000);
