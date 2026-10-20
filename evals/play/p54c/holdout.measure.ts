/**
 * P54C T16: zapečetěný holdout (80 vět nezávislého autora, T2) otevřený jednou. Každá věta jde cestou produkce bez
 * modelu – klasifikátor a návrh (`draftGameSpecWithMeta`, semínko 1, Rapier načtený) – a robot světa (`verifyArcade`)
 * hraje hru, kterou návrh vrátil. Nic se podle výsledku neladí.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p54c/holdout.measure.ts
 *
 * Před prvním čtením vět zapíše `holdout-opened.json` (otisk, commit, čas); existuje-li, běh odmítne – holdout
 * otevřený dvakrát je dev sada. Výsledek `final.json`; věty se na výstup nevypisují, jen id.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { classifyGenre } from '../../../src/play/genre/classify';

const DIR = join(process.cwd(), 'evals', 'play', 'p54c');
const HOLDOUT = join(DIR, 'holdout.json');
const OPENED = join(DIR, 'holdout-opened.json');
const OUT = join(DIR, 'final.json');
/** Týž otisk jako `P54C_HOLDOUT_SHA256` v `__tests__/sets.test.ts` a v README (T2). */
const SHA256 = 'c3d545c53a59d8569f264466818bf3172fbba49a9914928d1efd7b6e650eca68';
const SEED = 1;
const NEW_GENRES = ['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push'] as const;
const MVP = new Set<string>(['catch', 'whack', 'defense', 'slice']);
/** Brány T16. */
const GATES = { targetGenre: 0.8, distractorStays: 0.85, playable: 1, winSeconds: 0.9 } as const;

interface HoldoutSentence { readonly id: string; readonly family: 'target' | 'distractor'; readonly genre: string | null; readonly text: string }
interface HoldoutRow {
  readonly id: string;
  readonly family: HoldoutSentence['family'];
  readonly genre: string | null;
  readonly classify: string;
  readonly draft: string | null;
  readonly cell: string | null;
  readonly fellBack: boolean;
  readonly genreOk: boolean;
  readonly classifyOk: boolean;
  readonly bot: { readonly wins: boolean; readonly seconds: number | null; readonly idleLoses: boolean; readonly replayEqual: boolean; readonly failures: readonly string[] };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const share = (hit: number, of: number) => ({ hit, of, share: of === 0 ? null : round(hit / of) });

it('opens the sealed P54C holdout once and writes final.json (T16)', async () => {
  if (existsSync(OPENED)) throw new Error('holdout-opened.json exists – the P54C holdout was already opened; a second run would make it a dev set');
  const bytes = readFileSync(HOLDOUT, 'utf8').replace(/\r\n/g, '\n');
  const sha = createHash('sha256').update(bytes, 'utf8').digest('hex');
  if (sha !== SHA256) throw new Error(`holdout.json SHA-256 ${sha} is not the sealed ${SHA256}`);
  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(OPENED, `${JSON.stringify({ schema: 'p54c-holdout-opened.v1', sha256: sha, openedAt: new Date().toISOString(), commit, by: 'P54C T16 (holdout.measure.ts)', note: 'Opened once for the final report; nothing is tuned on it.' }, null, 1)}\n`);

  await loadRapier();
  const sentences = (JSON.parse(bytes) as { sentences: HoldoutSentence[] }).sentences;
  const rows: HoldoutRow[] = [];
  for (const sentence of sentences) {
    const ranking = classifyGenre(sentence.text, null);
    const top = ranking.ranked[0]!;
    let meta: ReturnType<typeof draftGameSpecWithMeta>;
    try {
      meta = draftGameSpecWithMeta(sentence.text, SEED);
    } catch (error) {
      // Holdout se otevírá jednou: pád návrhu je řádek výsledku (nehratelná věta), ne konec běhu.
      rows.push({ id: sentence.id, family: sentence.family, genre: sentence.genre, classify: `${top.genre}.${top.mode}`, draft: null, cell: null, fellBack: true, genreOk: false, classifyOk: false, bot: { wins: false, seconds: null, idleLoses: false, replayEqual: false, failures: [`draft threw: ${(error as Error).message.slice(0, 160)}`] } });
      continue;
    }
    const draft = meta.genre === null ? null : meta.genre.genre;
    await preloadPhysics(meta.spec, loadRapier);
    const made = arcadeWorldOf(meta.spec, SEED);
    const verdict = made.ok ? verifyArcade(made.world, undefined, made.roleBindings) : null;
    rows.push({
      id: sentence.id,
      family: sentence.family,
      genre: sentence.genre,
      classify: `${top.genre}.${top.mode}`,
      draft: meta.genre === null ? null : `${meta.genre.genre}.${meta.genre.mode}`,
      cell: meta.composition?.cellId ?? null,
      fellBack: meta.fellBack,
      genreOk: sentence.family === 'target' ? draft === sentence.genre : !(NEW_GENRES as readonly string[]).includes(draft ?? ''),
      classifyOk: sentence.family === 'target' ? top.genre === sentence.genre : !(NEW_GENRES as readonly string[]).includes(top.genre),
      bot: verdict === null
        ? { wins: false, seconds: null, idleLoses: false, replayEqual: false, failures: made.ok ? [] : made.issues.slice(0, 3) }
        : { wins: verdict.bot.outcome === 'won', seconds: Math.round((verdict.bot.tick / 60) * 10) / 10, idleLoses: verdict.idle.outcome !== 'won', replayEqual: verdict.replayEqual, failures: verdict.failures.slice(0, 3) },
    });
    console.log(`${sentence.id} ${rows.at(-1)!.draft ?? 'none'} ${rows.at(-1)!.bot.wins ? 'won' : 'NOT WON'} ${String(rows.at(-1)!.bot.seconds)}`);
  }

  const targets = rows.filter((row) => row.family === 'target');
  const distractors = rows.filter((row) => row.family === 'distractor');
  const inBand = (row: (typeof rows)[number]) => row.bot.wins && row.bot.seconds !== null && row.bot.seconds >= 30 && row.bot.seconds <= 90;
  const byGenre = Object.fromEntries(NEW_GENRES.map((genre) => {
    const of = targets.filter((row) => row.genre === genre);
    return [genre, {
      phase: MVP.has(genre) ? 'mvp' : 'after-submission',
      genre: share(of.filter((row) => row.genreOk).length, of.length),
      classify: share(of.filter((row) => row.classifyOk).length, of.length),
      botWins: share(of.filter((row) => row.bot.wins).length, of.length),
      winSeconds: share(of.filter(inBand).length, of.length),
      played: Object.fromEntries([...new Set(of.map((row) => row.draft ?? 'none'))].map((played) => [played, of.filter((row) => (row.draft ?? 'none') === played).length])),
    }];
  }));
  const summary = {
    targetGenre: { ...share(targets.filter((row) => row.genreOk).length, targets.length), gate: GATES.targetGenre },
    targetClassify: share(targets.filter((row) => row.classifyOk).length, targets.length),
    distractorStays: { ...share(distractors.filter((row) => row.genreOk).length, distractors.length), gate: GATES.distractorStays, playedNew: distractors.filter((row) => !row.genreOk).map((row) => `${row.id}: ${String(row.draft)}`) },
    playable: { ...share(rows.filter((row) => row.bot.wins).length, rows.length), gate: GATES.playable, notWon: rows.filter((row) => !row.bot.wins).map((row) => `${row.id}: ${String(row.draft)} ${row.bot.failures.join('; ')}`.slice(0, 240)) },
    winSeconds: { ...share(rows.filter(inBand).length, rows.length), gate: GATES.winSeconds, targets: share(targets.filter(inBand).length, targets.length), outside: rows.filter((row) => row.bot.wins && !inBand(row)).map((row) => `${row.id}: ${String(row.draft)} ${String(row.bot.seconds)} s`) },
    idleLoses: share(rows.filter((row) => row.bot.idleLoses).length, rows.length),
    replayEqual: share(rows.filter((row) => row.bot.replayEqual).length, rows.length),
    byGenre,
  };
  writeFileSync(OUT, `${JSON.stringify({
    schema: 'p54c-final.v1',
    about: 'P54C T16: the sealed holdout (holdout.json, 60 targets + 20 distractors by an independent author) opened once. Classifier and quick draft on seed 1 with Rapier loaded (production path without a model); bot = verifyArcade on the drafted game. genreOk: a target plays its genre, a distractor plays none of the eight new genres. See final.md.',
    commit,
    sha256: sha,
    gates: GATES,
    summary,
    rows,
  }, null, 1)}\n`);
  console.log(`target genre ${String(summary.targetGenre.hit)}/${String(summary.targetGenre.of)} · distractors stay ${String(summary.distractorStays.hit)}/${String(summary.distractorStays.of)} · playable ${String(summary.playable.hit)}/${String(summary.playable.of)} · 30–90 s ${String(summary.winSeconds.hit)}/${String(summary.winSeconds.of)}`);
}, 60 * 60_000);
