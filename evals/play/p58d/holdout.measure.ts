/**
 * P58D T4: žánr hry, kterou hráč hraje od příchodu čtení (~3 s po odeslání věty), na zapečetěné sadě P58B.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p58d/holdout.measure.ts
 * ```
 *
 * Bez nového volání: čtení jsou uložená z P58B T8 (`p58b/readings/holdout.astra.json`, astra `low`, cesta AI verze –
 * totéž čtení, které platí režisér a ze kterého staví návrh `onDraft`). Sada je otevřená od P58B T8 (`holdout-opened.json`);
 * měří se na ní jednou a nic se podle ní neladí.
 *
 * Cesta je ta produktová (`games/route.ts` → `_upgrade.ts`): čtečka jen pro AI verzi, takže rychlá hra je návrh bez čtení
 * (semínko 1). Věta, kterou rozhodnutí o řetězu pošle do řetězu, upgrade nemá – hraje řetěz. Jinak návrh se čtením
 * (semínko 1, jako `direct()` bez `deps.seed`) a když `playsOtherGenre`, projde `publishReadSpec` na semínkách serveru
 * (`derivedSeeds(seedFrom(věta))`) do paměťového úložiště; publikovaný je mezistupeň, nepublikovaný nechá rychlou hru.
 * Cíl a past se počítají jako v P58B (`genreOk`). Výsledek `result.json`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { derivedSeeds, publishReadSpec, seedFrom } from '../../../src/app/api/play/_publish';
import { playsOtherGenre } from '../../../src/app/api/play/_upgrade';
import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { buildChain } from '../../../src/play/chain/build';
import { chainOrSingle } from '../../../src/play/chain/decide';
import { readForChain } from '../../../src/play/chain/read';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { classifyGenre } from '../../../src/play/genre/classify';
import { readerPromptVersion } from '../../../src/play/read/client';
import type { Reading } from '../../../src/play/read/schema';
import type { GameSpecV1 } from '../../../src/play/spec';
import { memoryVersionStore } from '../../../src/play/version/store';

import { ROOT } from '../p56a/rows';
import { P58B_HOLDOUT_SHA256, sha256Lf } from '../p58b/seal';

const DIR = join(ROOT, 'p58d');
const SEED = 1;
/**
 * Brány T4: žánr jako AI verze P58B (≥ 48/60, ≥ 18/20); robot vyhraje, nečinný prohraje a replay sedí na každé jedné hře,
 * kterou hráč od tří sekund hraje. Řetěz mikroher tu robot nehraje – ověřuje ho jeho vlastní publikace (`publishChain`).
 */
const GATES = { targetGenre: 48, trapOffLure: 18 } as const;

interface HoldoutSentence { readonly id: string; readonly family: 'target' | 'trap'; readonly genre: string | null; readonly lure: string | null; readonly text: string }
interface StoredReading { readonly id: string; readonly text: string; readonly ms: number; readonly reading: Reading | null }

const genreOf = (draft: string | null): string | null => (draft == null ? null : draft.split('.')[0]!);
const modeOf = (spec: GameSpecV1): string | null => (spec.genre === undefined ? null : `${spec.genre.id}.${spec.genre.mode}`);

/** Robot vyhraje, nečinný prohraje a replay sedí – tatáž kontrola jako P58B T8 (`verifyArcade`, semínko 1). */
async function botOf(spec: GameSpecV1) {
  try {
    await preloadPhysics(spec, loadRapier);
    const made = arcadeWorldOf(spec, SEED);
    if (!made.ok) return { wins: false, idleLoses: false, replayEqual: false, why: made.issues[0] ?? 'world not built' };
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const wins = verdict.bot.outcome === 'won';
    const idleLoses = verdict.idle.outcome !== 'won';
    return { wins, idleLoses, replayEqual: verdict.replayEqual, why: wins && idleLoses && verdict.replayEqual ? null : (verdict.failures[0] ?? `bot ${verdict.bot.outcome}, idle ${verdict.idle.outcome}`) };
  } catch (error) {
    return { wins: false, idleLoses: false, replayEqual: false, why: `bot threw: ${(error as Error).message.slice(0, 160)}` };
  }
}

it('measures the game played from the reading on the sealed P58B set (T4)', async () => {
  const holdoutBytes = readFileSync(join(ROOT, 'p58b', 'holdout.json'), 'utf8').replace(/\r\n/g, '\n');
  if (sha256Lf(holdoutBytes) !== P58B_HOLDOUT_SHA256) throw new Error('p58b/holdout.json does not match its seal');
  const stored = JSON.parse(readFileSync(join(ROOT, 'p58b', 'readings', 'holdout.astra.json'), 'utf8')) as { promptVersion: string; model: string; effort: string; readings: StoredReading[] };
  const sentences = (JSON.parse(holdoutBytes) as { sentences: HoldoutSentence[] }).sentences;
  const readingById = new Map(stored.readings.map((row) => [row.id, row]));
  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  await loadRapier();

  const versions = memoryVersionStore();
  const rows = [];
  for (const sentence of sentences) {
    const stored = readingById.get(sentence.id);
    if (stored === undefined || stored.text !== sentence.text) throw new Error(`${sentence.id}: no stored reading for this sentence`);
    const reading = stored.reading;
    const seeds = derivedSeeds(seedFrom(sentence.text.trim()));
    const quickMeta = draftGameSpecWithMeta(sentence.text, SEED, { reading: null });
    const quick = quickMeta.spec;
    const chained = chainOrSingle(sentence.text, readForChain(sentence.text, null), classifyGenre(sentence.text, null)) === 'chain'
      && buildChain(sentence.text, readForChain(sentence.text, null), seeds[0]!).ok;
    const readMeta = reading === null ? null : draftGameSpecWithMeta(sentence.text, SEED, { reading });
    const read = chained ? null : (readMeta?.spec ?? null);
    const differs = read !== null && playsOtherGenre(quick, read);
    let publishIssue: string | null = null;
    if (differs) {
      const published = await publishReadSpec(versions, read, seeds, null, { relation: 'reading' });
      if (!published.ok) publishIssue = published.issues?.[0] ?? String(published.response.status);
    }
    const step = differs && publishIssue === null;
    const played = chained ? null : step ? read : quick;
    // Žánr hry jako v P58B: `meta.genre` návrhu. Hra z mřížky (voyage, quest) ho ve specu nenese a `playsOtherGenre` ji nevidí.
    const metaOf = (meta: ReturnType<typeof draftGameSpecWithMeta> | null): string | null => (meta?.genre == null ? null : `${meta.genre.genre}.${meta.genre.mode}`);
    const quickGenre = metaOf(quickMeta);
    const readGenre = metaOf(readMeta);
    const playedGenre = chained ? 'chain' : step ? readGenre : quickGenre;
    const ok = (draft: string | null) => (sentence.family === 'target' ? genreOf(draft) === genreOf(sentence.genre) : draft !== sentence.lure);
    // Kdyby řetěz dostal čtení (dnes ho nedostane – řetěz nemá AI verzi, čtení se neplatí): rozhodl by se se čtením znovu?
    const chainWithReading = chained && reading !== null ? chainOrSingle(sentence.text, readForChain(sentence.text, reading), classifyGenre(sentence.text, reading)) : null;
    rows.push({
      id: sentence.id, family: sentence.family, genre: sentence.genre, lure: sentence.lure, readMs: stored.ms,
      quick: quickGenre, read: readGenre, chained, chainWithReading, step, publishIssue, played: playedGenre,
      specGenre: { quick: modeOf(quick), read: readMeta === null ? null : modeOf(readMeta.spec) },
      genreOk: ok(playedGenre), quickGenreOk: ok(quickGenre), readGenreOk: ok(readGenre),
      bot: played === null ? null : await botOf(played),
    });
  }

  const targets = rows.filter((row) => row.family === 'target');
  const traps = rows.filter((row) => row.family === 'trap');
  type R = (typeof rows)[number];
  const count = (list: readonly R[], hit: (row: R) => boolean) => ({ hit: list.filter(hit).length, of: list.length });
  const games = rows.filter((row) => row.bot !== null);
  const steps = rows.filter((row) => row.step);
  const readMs = rows.filter((row) => row.step).map((row) => row.readMs).sort((a, b) => a - b);
  const summary = {
    targetGenre: count(targets, (row) => row.genreOk),
    trapOffLure: count(traps, (row) => row.genreOk),
    quickTargetGenre: count(targets, (row) => row.quickGenreOk),
    quickTrapOffLure: count(traps, (row) => row.quickGenreOk),
    steps: steps.length,
    stepsNotPublished: rows.filter((row) => row.publishIssue !== null).map((row) => `${row.id}: ${row.read} not published (${row.publishIssue}), plays ${row.quick}`),
    chained: count(rows, (row) => row.chained),
    chainedTargets: count(targets, (row) => row.chained),
    chainedTraps: count(traps, (row) => row.chained),
    // Protipříklad pro rozhodnutí majitele, ne brána: řetěz by přešel na hru ze čtení, kdyby čtení dostal.
    ifChainReadTargetGenre: count(targets, (row) => (row.chained ? row.readGenreOk : row.genreOk)),
    ifChainReadTrapOffLure: count(traps, (row) => (row.chained ? row.readGenreOk : row.genreOk)),
    chainWithReadingStillChain: count(rows.filter((row) => row.chained), (row) => row.chainWithReading === 'chain'),
    bot: count(games, (row) => row.bot!.wins),
    idleLoses: count(games, (row) => row.bot!.idleLoses),
    replayEqual: count(games, (row) => row.bot!.replayEqual),
    stepBot: count(steps, (row) => row.bot?.wins === true && row.bot.idleLoses && row.bot.replayEqual),
    stepReadMs: { p50: readMs[Math.floor(readMs.length / 2)] ?? null, max: readMs.at(-1) ?? null },
    stepsWrongToRight: steps.filter((row) => row.genreOk && !row.quickGenreOk).length,
    stepsRightToWrong: steps.filter((row) => !row.genreOk && row.quickGenreOk).map((row) => `${row.id}: ${row.quick} -> ${row.played}`),
    targetMisses: targets.filter((row) => !row.genreOk).map((row) => `${row.id}: ${row.genre} -> ${row.played} (quick ${row.quick}, reading ${row.read ?? 'none'})`),
    trapsOnLure: traps.filter((row) => !row.genreOk).map((row) => `${row.id}: lure ${row.lure} played (quick ${row.quick}, reading ${row.read ?? 'none'})`),
    botFailures: games.filter((row) => row.bot!.why !== null).map((row) => `${row.id}: ${row.bot!.why}`),
  };
  const met = {
    targetGenre: summary.targetGenre.hit >= GATES.targetGenre,
    trapOffLure: summary.trapOffLure.hit >= GATES.trapOffLure,
    bot: summary.bot.hit === summary.bot.of,
    idleLoses: summary.idleLoses.hit === summary.idleLoses.of,
    replayEqual: summary.replayEqual.hit === summary.replayEqual.of,
  };
  const reader = { model: stored.model, effort: stored.effort, promptVersion: stored.promptVersion, promptVersionNow: readerPromptVersion() };
  writeFileSync(join(DIR, 'result.json'), `${JSON.stringify({ schema: 'p58d-result.v1', commit, sha256: P58B_HOLDOUT_SHA256, readings: 'evals/play/p58b/readings/holdout.astra.json', reader, seed: SEED, gates: GATES, met, summary, rows }, null, 1)}\n`);
  console.log(`targets ${summary.targetGenre.hit}/60 (quick ${summary.quickTargetGenre.hit}) · traps ${summary.trapOffLure.hit}/20 (quick ${summary.quickTrapOffLure.hit}) · steps ${steps.length} · bot ${summary.bot.hit}/80 idle ${summary.idleLoses.hit}/80 replay ${summary.replayEqual.hit}/80 · prompt ${reader.promptVersion === reader.promptVersionNow ? 'same' : 'CHANGED'}`);
}, 60 * 60_000);
