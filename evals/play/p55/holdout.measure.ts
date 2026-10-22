/**
 * P55 T9: zapečetěná sada (80 vět nezávislého autora, T2) otevřená jednou. Každá věta jde cestou produkce bez
 * modelu – klasifikátor a návrh (`draftGameSpecWithMeta`, semínko 1, Rapier načtený) – a robot světa (`verifyArcade`)
 * hraje hru, kterou návrh vrátil. Nic se podle výsledku neladí.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p55/holdout.measure.ts
 *
 * Druhé otevření odmítne `openSealedOnce` (`seal.ts`). Výsledek `final.json`; věty se na výstup nevypisují, jen id.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';

import { P55_GENRES, P55_HOLDOUT_SHA256, P55_LANE_GENRES, openSealedOnce } from './seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p55');
const SEED = 1;
/** Brány T9. */
const GATES = { targetGenre: 48, laneGenre: 24, distractorStays: 19, playable: 80, winSeconds: 76 } as const;

interface HoldoutSentence { readonly id: string; readonly family: 'target' | 'distractor'; readonly genre: string | null; readonly text: string }

interface HoldoutRow {
  readonly id: string;
  readonly family: HoldoutSentence['family'];
  readonly genre: string | null;
  readonly draft: string | null;
  readonly genreOk: boolean;
  readonly bot: { readonly wins: boolean; readonly seconds: number | null; readonly idleLoses: boolean; readonly replayEqual: boolean; readonly failures: readonly string[] };
}

const isNew = (genre: string | null): boolean => (P55_GENRES as readonly string[]).includes(genre ?? '');

it('opens the sealed P55 holdout once and writes final.json (T9)', async () => {
  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const bytes = openSealedOnce(DIR, P55_HOLDOUT_SHA256, commit, 'P55 T9 (holdout.measure.ts)');
  await loadRapier();
  const rows: HoldoutRow[] = [];
  for (const sentence of (JSON.parse(bytes) as { sentences: HoldoutSentence[] }).sentences) {
    const base = { id: sentence.id, family: sentence.family, genre: sentence.genre };
    let meta: ReturnType<typeof draftGameSpecWithMeta>;
    try {
      meta = draftGameSpecWithMeta(sentence.text, SEED);
    } catch (error) {
      // Sada se otevírá jednou: pád návrhu je řádek výsledku (nehratelná věta), ne konec běhu.
      rows.push({ ...base, draft: null, genreOk: false, bot: { wins: false, seconds: null, idleLoses: false, replayEqual: false, failures: [`draft threw: ${(error as Error).message.slice(0, 160)}`] } });
      continue;
    }
    const draft = meta.genre === null ? null : meta.genre.genre;
    await preloadPhysics(meta.spec, loadRapier);
    const made = arcadeWorldOf(meta.spec, SEED);
    const verdict = made.ok ? verifyArcade(made.world, undefined, made.roleBindings) : null;
    rows.push({
      ...base,
      draft: meta.genre === null ? null : `${meta.genre.genre}.${meta.genre.mode}`,
      genreOk: sentence.family === 'target' ? draft === sentence.genre : !isNew(draft),
      bot: verdict === null
        ? { wins: false, seconds: null, idleLoses: false, replayEqual: false, failures: made.ok ? [] : made.issues.slice(0, 3) }
        : { wins: verdict.bot.outcome === 'won', seconds: Math.round((verdict.bot.tick / 60) * 10) / 10, idleLoses: verdict.idle.outcome !== 'won', replayEqual: verdict.replayEqual, failures: verdict.failures.slice(0, 3) },
    });
  }

  const targets = rows.filter((row) => row.family === 'target');
  const inBand = (row: (typeof rows)[number]) => row.bot.wins && row.bot.seconds !== null && row.bot.seconds >= 30 && row.bot.seconds <= 90;
  const count = (list: readonly (typeof rows)[number][], ok: (row: (typeof rows)[number]) => boolean) => ({ hit: list.filter(ok).length, of: list.length });
  const summary = {
    targetGenre: count(targets, (row) => row.genreOk),
    laneGenre: count(targets.filter((row) => (P55_LANE_GENRES as readonly string[]).includes(row.genre ?? '')), (row) => row.genreOk),
    distractorStays: count(rows.filter((row) => row.family === 'distractor'), (row) => row.genreOk),
    playable: count(rows, (row) => row.bot.wins),
    winSeconds: count(rows, inBand),
    idleLoses: count(rows, (row) => row.bot.idleLoses),
    replayEqual: count(rows, (row) => row.bot.replayEqual),
    byGenre: Object.fromEntries(P55_GENRES.map((genre) => {
      const of = targets.filter((row) => row.genre === genre);
      return [genre, { ...count(of, (row) => row.genreOk), played: Object.fromEntries([...new Set(of.map((row) => row.draft ?? 'none'))].map((played) => [played, of.filter((row) => (row.draft ?? 'none') === played).length])) }];
    })),
  };
  writeFileSync(join(DIR, 'final.json'), `${JSON.stringify({ schema: 'p55-final.v1', commit, sha256: P55_HOLDOUT_SHA256, gates: GATES, summary, rows }, null, 1)}\n`);
  console.log(`target ${String(summary.targetGenre.hit)}/60 · lanes ${String(summary.laneGenre.hit)}/32 · distractors ${String(summary.distractorStays.hit)}/20 · playable ${String(summary.playable.hit)}/80 · 30–90 s ${String(summary.winSeconds.hit)}/80`);
}, 60 * 60_000);
