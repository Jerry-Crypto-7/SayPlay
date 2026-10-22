/**
 * P56A T11: čtečka gpt-oss-20b na dev sadách – co z věty dojde do hry se čtením oproti bez něj.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p56a/dev.measure.ts
 * ```
 *
 * Čte uložená čtení `readings/<sada>.gpt-oss-20b.json` (T4, `read-all.cmd`), čtečku nevolá. Žánr na p55 holdout-opened
 * po žánrech jako `p55/holdout.measure.ts` (cíl = žánr věty, past = nehraje nový žánr P54C), plus srovnání politik:
 * čtení samo, slovník sám, dnešní politika (T5 varianta a: slovník, když slyší nový žánr, jinak čtení) a strop „aspoň
 * jeden trefí“. Hrdina a protivník s úrovní modelu, louka z nouze (T7), názvy (T8), robot vyhraje / nečinný prohraje /
 * replay sedí u každé věty se čtením, latence čtečky z uložených čtení. Píše `dev-result.json` bez času běhu, takže
 * opakovaný běh beze změny nechá git čistý; `dev-result.md` je výklad těch čísel.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import type { Reading } from '../../../src/play/read/schema';

import { P55_GENRES } from '../p55/seal';

import { ROOT, type Row, type Sentence, castSummary, panelSummary, readSet, rowOf } from './rows';

const SEED = 1;
const MODEL = 'gpt-oss-20b';
/** Úroveň volby modelu (`ChoiceLevel` v `arcade/models.ts`): `fallback` = model nesedí na slovo. */
const LEVELS = ['identity', 'near', 'class', 'fallback'] as const;
const SETS = [
  ['p55HoldoutOpened', 'p55/holdout.json', 'p55-holdout'],
  ['p54cDev', 'p54c/dev.json', 'p54c-dev'],
  ['p54cHoldoutOpened', 'p54c/holdout.json', 'p54c-holdout'],
  ['p30Dev', 'p30/dev.json', 'p30-dev'],
  ['p43Panel', 'p43/panel.json', 'p43-panel'],
  ['audit12', 'p56a/audit-12.json', 'audit-12'],
] as const;

interface ReadRow { readonly id: string; readonly ms: number; readonly reading: Reading | null }
const readingsOf = (name: string): ReadonlyMap<string, ReadRow> =>
  new Map((JSON.parse(readFileSync(join(ROOT, 'p56a', 'readings', `${name}.${MODEL}.json`), 'utf8')) as { readings: ReadRow[] }).readings.map((row) => [row.id, row]));

const genreOf = (draft: string | null | undefined): string | null => (draft == null ? null : draft.split('.')[0]!);
const isNew = (genre: string | null): boolean => genre !== null && (P55_GENRES as readonly string[]).includes(genre);
/** Věta jmenuje louku, park nebo farmu (jako `world.test.ts`). */
const saysMeadow = (text: string): boolean => /\b(?:meadow|park|farm|garden|field|lawn|pasture|orchard|barn|countryside)/i.test(text);
const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** Žánr P55: cíl trefí žánr věty, past nehraje nový žánr. */
function p55Genre(sentences: readonly Sentence[], read: ReadonlyMap<string, ReadRow>, withRead: readonly Row[], words: readonly Row[]) {
  const targets = sentences.flatMap((sentence, i) => (sentence.family === 'target' ? [i] : []));
  const traps = sentences.flatMap((sentence, i) => (sentence.family !== 'target' ? [i] : []));
  const readGenre = (i: number): string | null => read.get(sentences[i]!.id)?.reading?.genre?.genre ?? null;
  const want = (i: number): string | null => sentences[i]!.genre ?? null;
  const policy = targets.filter((i) => genreOf(withRead[i]!.draft) === want(i));
  const misses = targets.filter((i) => genreOf(withRead[i]!.draft) !== want(i)).map((i) => {
    const wordsGenre = genreOf(words[i]!.draft);
    const why = readGenre(i) === want(i)
      ? `reading right, words ${wordsGenre ?? 'none'} heard a new genre and won`
      : wordsGenre === want(i)
        ? `words right, reading said ${readGenre(i) ?? 'nothing'}`
        : `both wrong: reading ${readGenre(i) ?? 'nothing'}, words ${wordsGenre ?? 'none'}`;
    return `${sentences[i]!.id} (${want(i)} -> ${genreOf(withRead[i]!.draft) ?? 'none'}): ${why} – "${sentences[i]!.text}"`;
  });
  return {
    targets: {
      of: targets.length,
      policy: policy.length,
      readingAlone: targets.filter((i) => readGenre(i) === want(i)).length,
      wordsAlone: targets.filter((i) => genreOf(words[i]!.draft) === want(i)).length,
      eitherRight: targets.filter((i) => readGenre(i) === want(i) || genreOf(words[i]!.draft) === want(i)).length,
      misses,
    },
    traps: {
      of: traps.length,
      stay: traps.filter((i) => !isNew(genreOf(withRead[i]!.draft))).length,
      readingAloneStays: traps.filter((i) => !isNew(readGenre(i))).length,
      playedNew: traps.filter((i) => isNew(genreOf(withRead[i]!.draft))).map((i) => `${sentences[i]!.id} -> ${withRead[i]!.draft}: reading ${readGenre(i) ?? 'nothing'} – "${sentences[i]!.text}"`),
    },
  };
}

/** Robot vyhraje, nečinný prohraje a replay sedí – hra se čtením, semínko 1. */
async function botOf(sentence: Sentence, reading: Reading | null) {
  try {
    const spec = draftGameSpecWithMeta(sentence.text, SEED, { reading }).spec;
    await preloadPhysics(spec, loadRapier);
    const made = arcadeWorldOf(spec, SEED);
    if (!made.ok) return { wins: false, idleLoses: false, replayEqual: false, why: made.issues[0] ?? 'world not built' };
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const wins = verdict.bot.outcome === 'won';
    const idleLoses = verdict.idle.outcome !== 'won';
    return { wins, idleLoses, replayEqual: verdict.replayEqual, why: wins && idleLoses && verdict.replayEqual ? null : (verdict.failures[0] ?? `bot ${verdict.bot.outcome}, idle ${verdict.idle.outcome}`) };
  } catch (error) {
    return { wins: false, idleLoses: false, replayEqual: false, why: `draft threw: ${(error as Error).message.slice(0, 160)}` };
  }
}

it('measures the P56A reader on the dev sets', async () => {
  await loadRapier();
  const out: Record<string, unknown> = {};
  const latency: number[] = [];
  const bots = { of: 0, wins: 0, idleLoses: 0, replayEqual: 0, failures: [] as string[] };
  for (const [name, path, file] of SETS) {
    const sentences = readSet(path);
    const read = readingsOf(file);
    const readingOf = (sentence: Sentence): Reading | null => read.get(sentence.id)?.reading ?? null;
    const withRead = sentences.map((sentence) => rowOf(sentence, readingOf(sentence)));
    const words = sentences.map((sentence) => rowOf(sentence));
    for (const row of read.values()) latency.push(row.ms);
    for (const sentence of sentences) {
      const reading = readingOf(sentence);
      if (reading === null) continue;
      const bot = await botOf(sentence, reading);
      bots.of += 1;
      bots.wins += Number(bot.wins);
      bots.idleLoses += Number(bot.idleLoses);
      bots.replayEqual += Number(bot.replayEqual);
      if (bot.why !== null) bots.failures.push(`${name}/${sentence.id}: ${bot.why} – "${sentence.text}"`);
    }
    const meadow = (rows: readonly Row[]) => sentences.filter((sentence, i) => 'look' in rows[i]! && (rows[i] as { look: string }).look === 'meadow' && !saysMeadow(sentence.text) && readingOf(sentence)?.world !== 'meadow').length;
    out[name] = {
      sentences: sentences.length,
      read: [...read.values()].filter((row) => row.reading !== null).length,
      ...(name === 'p55HoldoutOpened' ? { genre: p55Genre(sentences, read, withRead, words) } : {}),
      cast: { reading: castSummary(sentences, withRead), words: castSummary(sentences, words) },
      ...(name === 'p43Panel' ? { panel: { reading: panelSummary(sentences, withRead), words: panelSummary(sentences, words) } } : {}),
      heroLevels: Object.fromEntries(LEVELS.map((level) => [level, withRead.filter((row) => 'heroLevel' in row && row.heroLevel === level).length])),
      foeLevels: Object.fromEntries(LEVELS.map((level) => [level, withRead.filter((row) => 'foeLevel' in row && row.foeLevel === level).length])),
      meadowNotNamed: { reading: meadow(withRead), words: meadow(words) },
      worldEmptyInReading: [...read.values()].filter((row) => row.reading !== null && row.reading.world === null).length,
      rows: withRead.map((row, i) => ({ ...row, words: { draft: words[i]!.draft, hero: 'hero' in words[i]! ? (words[i] as { hero: string | null }).hero : null, title: 'title' in words[i]! ? (words[i] as { title: string }).title : null } })),
    };
  }
  const result = {
    schema: 'p56a-dev-result.v1',
    model: MODEL,
    transport: 'llamacpp',
    seed: SEED,
    latencyMs: { n: latency.length, p50: quantile(latency, 0.5), p95: quantile(latency, 0.95), max: Math.max(...latency) },
    bots,
    sets: out,
  };
  writeFileSync(join(ROOT, 'p56a', 'dev-result.json'), `${JSON.stringify(result, null, 1)}\n`);
}, 3_600_000);
