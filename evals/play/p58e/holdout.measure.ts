/**
 * P58E T4: žánr hry, kterou hráč hraje od příchodu čtení, na zapečetěné sadě P58B – teď i u vět, které hrají řetěz.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p58e/holdout.measure.ts
 * ```
 *
 * Bez nového volání: čtení jsou uložená z P58B T8 (`p58b/readings/holdout.astra.json`, astra `low`). Sada je otevřená
 * od P58B T8 (`holdout-opened.json`); měří se na ní jednou a nic se podle ní neladí.
 *
 * Cesta je ta produktová. Věta jedné hry jako P58D T4 (`directUpgrade`): rychlá hra je návrh bez čtení (semínko 1), návrh
 * se čtením ji nahradí, když `playsOtherGenre` a projde `publishReadSpec`. Věta, kterou rozhodnutí bez čtení pošle do
 * řetězu, jde přes `publishChain` jako route a potom jako `runChainReading` (`_upgrade.ts`): od P58F návrh ze čtení
 * (semínko 1) projde `publishReadSpec` jako dítě řetězu (`relation: 'reading'`) vždy, bez porovnání žánru; řetězem zůstane
 * jen věta, která o víc her výslovně žádá (`CHAIN_CUES`). Cíl a past jako P58B (`genreOk`).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { derivedSeeds, publishChain, publishReadSpec, seedFrom } from '../../../src/app/api/play/_publish';
import { playsOtherGenre } from '../../../src/app/api/play/_upgrade';
import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { buildChain } from '../../../src/play/chain/build';
import { CHAIN_CUES, chainOrSingle } from '../../../src/play/chain/decide';
import { readForChain } from '../../../src/play/chain/read';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { classifyGenre } from '../../../src/play/genre/classify';
import { readerPromptVersion } from '../../../src/play/read/client';
import type { Reading } from '../../../src/play/read/schema';
import type { GameSpecV1 } from '../../../src/play/spec';
import { memoryVersionStore } from '../../../src/play/version/store';

import { ROOT } from '../p56a/rows';
import { P58B_HOLDOUT_SHA256, sha256Lf } from '../p58b/seal';

const DIR = join(ROOT, 'p58e');
const SEED = 1;
/** Brány T4 (Goal plánu): ≥ 48/60 cílů, ≥ 18/20 pastí; robot vyhraje, nečinný prohraje a replay sedí na každé jedné hře. */
const GATES = { targetGenre: 48, trapOffLure: 18 } as const;

interface HoldoutSentence { readonly id: string; readonly family: 'target' | 'trap'; readonly genre: string | null; readonly lure: string | null; readonly text: string }
interface StoredReading { readonly id: string; readonly text: string; readonly ms: number; readonly reading: Reading | null }

const genreOf = (draft: string | null): string | null => (draft == null ? null : draft.split('.')[0]!);
const modeOf = (spec: GameSpecV1): string | null => (spec.genre === undefined ? null : `${spec.genre.id}.${spec.genre.mode}`);

/** Robot vyhraje, nečinný prohraje a replay sedí – tatáž kontrola jako P58B T8 a P58D T4 (`verifyArcade`, semínko 1). */
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

it('measures the game played from the reading on the sealed P58B set, chains included (T4)', async () => {
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
    const quickRead = readForChain(sentence.text, null);
    let chainId: string | null = null;
    // Řetěz, který neprojde vlastní kontrolou (422), route zahodí a hraje jednu hru – tady stejně.
    let chainIssue: string | null = null;
    if (chainOrSingle(sentence.text, quickRead, classifyGenre(sentence.text, null)) === 'chain') {
      const built = buildChain(sentence.text, quickRead, seeds[0]!);
      if (built.ok) {
        const published = await publishChain(versions, built.chain, null, { origin: { sentence: sentence.text, seed: null } });
        if (published.ok) chainId = published.value.game.version.versionId;
        else chainIssue = (published.issues ?? [String(published.response.status)]).slice(0, 2).join(' ');
      }
    }
    const chained = chainId !== null;
    const readMeta = reading === null ? null : draftGameSpecWithMeta(sentence.text, SEED, { reading });
    // Řetěz se čtením rozhodne znovu (`runChainReading`); věta jedné hry má čtení z AI verze a řetěz už neřeší.
    // P58F: řetěz přejde na hru ze čtení vždy, kromě věty, která o víc her výslovně žádá (`runChainReading`).
    const chainWithReading = chained && reading !== null ? (CHAIN_CUES.test(sentence.text.toLowerCase()) ? 'chain' : 'single') : null;
    const read = chained ? (chainWithReading === 'single' ? readMeta!.spec : null) : (readMeta?.spec ?? null);
    // Hra ze čtení řetězu nahradí řetěz vždy; hra ze čtení jedné hry jen tam, kde hraje jiný žánr než rychlá hra.
    const candidate = read !== null && (chained || playsOtherGenre(quick, read));
    let publishIssue: string | null = null;
    if (candidate) {
      const published = await publishReadSpec(versions, read, seeds, chainId, { relation: 'reading' });
      if (!published.ok) publishIssue = published.issues?.[0] ?? String(published.response.status);
    }
    const step = candidate && publishIssue === null;
    const played = step ? read : chained ? null : quick;
    // Žánr hry jako v P58B: `meta.genre` návrhu. Hra z mřížky (voyage, quest) ho ve specu nenese a `playsOtherGenre` ji nevidí.
    const metaOf = (meta: ReturnType<typeof draftGameSpecWithMeta> | null): string | null => (meta?.genre == null ? null : `${meta.genre.genre}.${meta.genre.mode}`);
    const quickGenre = metaOf(quickMeta);
    const readGenre = metaOf(readMeta);
    const playedGenre = step ? readGenre : chained ? 'chain' : quickGenre;
    const ok = (draft: string | null) => (sentence.family === 'target' ? genreOf(draft) === genreOf(sentence.genre) : draft !== sentence.lure);
    rows.push({
      id: sentence.id, family: sentence.family, genre: sentence.genre, lure: sentence.lure, readMs: stored.ms,
      quick: quickGenre, read: readGenre, chained, chainIssue, chainWithReading, step, publishIssue, played: playedGenre,
      specGenre: { quick: modeOf(quick), read: readMeta === null ? null : modeOf(readMeta.spec) },
      genreOk: ok(playedGenre), quickGenreOk: ok(quickGenre), readGenreOk: ok(readGenre),
      bot: played === null ? null : await botOf(played),
    });
  }

  const targets = rows.filter((row) => row.family === 'target');
  const traps = rows.filter((row) => row.family === 'trap');
  type R = (typeof rows)[number];
  const count = (list: readonly R[], hit: (row: R) => boolean) => ({ hit: list.filter(hit).length, of: list.length });
  const ms = (list: readonly R[]) => {
    const sorted = list.map((row) => row.readMs).sort((a, b) => a - b);
    return { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null };
  };
  const games = rows.filter((row) => row.bot !== null);
  const chains = rows.filter((row) => row.chained);
  const chainSteps = chains.filter((row) => row.step);
  const singleSteps = rows.filter((row) => !row.chained && row.step);
  const summary = {
    targetGenre: count(targets, (row) => row.genreOk),
    trapOffLure: count(traps, (row) => row.genreOk),
    quickTargetGenre: count(targets, (row) => row.quickGenreOk),
    quickTrapOffLure: count(traps, (row) => row.quickGenreOk),
    chained: count(rows, (row) => row.chained),
    chainsNotPublished: rows.filter((row) => row.chainIssue !== null).map((row) => `${row.id}: ${row.chainIssue}, plays ${row.played}`),
    // Placené čtení navíc: každá věta, kterou rozhodnutí bez čtení pošle do řetězu, jedno čtení.
    chainReads: chains.length,
    chainSteps: chainSteps.length,
    chainStaysChain: count(chains, (row) => !row.step),
    chainStaysChainTargets: count(targets.filter((row) => row.chained), (row) => !row.step),
    chainStaysChainTraps: count(traps.filter((row) => row.chained), (row) => !row.step),
    singleSteps: singleSteps.length,
    stepsNotPublished: rows.filter((row) => row.publishIssue !== null).map((row) => `${row.id}: ${row.read} not published (${row.publishIssue}), plays ${row.chained ? 'chain' : row.quick}`),
    bot: count(games, (row) => row.bot!.wins),
    idleLoses: count(games, (row) => row.bot!.idleLoses),
    replayEqual: count(games, (row) => row.bot!.replayEqual),
    chainStepBot: count(chainSteps, (row) => row.bot?.wins === true && row.bot.idleLoses && row.bot.replayEqual),
    chainStepReadMs: ms(chainSteps),
    singleStepReadMs: ms(singleSteps),
    chainStepsWrongToRight: chainSteps.filter((row) => row.genreOk && !row.quickGenreOk).length,
    chainStepTrapsOnLure: chainSteps.filter((row) => row.family === 'trap' && !row.genreOk).map((row) => `${row.id}: lure ${row.lure} played from the reading`),
    targetMisses: targets.filter((row) => !row.genreOk).map((row) => `${row.id}: ${row.genre} -> ${row.played} (quick ${row.quick}, reading ${row.read ?? 'none'}, chain with reading ${row.chainWithReading ?? '-'})`),
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
  writeFileSync(join(DIR, 'result.json'), `${JSON.stringify({ schema: 'p58e-result.v1', commit, sha256: P58B_HOLDOUT_SHA256, readings: 'evals/play/p58b/readings/holdout.astra.json', reader, seed: SEED, gates: GATES, met, summary, rows }, null, 1)}\n`);
  console.log(`targets ${summary.targetGenre.hit}/60 (quick ${summary.quickTargetGenre.hit}) · traps ${summary.trapOffLure.hit}/20 (quick ${summary.quickTrapOffLure.hit}) · chains ${chains.length} -> reading ${chainSteps.length} · bot ${summary.bot.hit}/${summary.bot.of} idle ${summary.idleLoses.hit} replay ${summary.replayEqual.hit} · prompt ${reader.promptVersion === reader.promptVersionNow ? 'same' : 'CHANGED'}`);
}, 60 * 60_000);
