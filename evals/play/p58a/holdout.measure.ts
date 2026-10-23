/**
 * P58A T9: robot vyhraje, nečinný prohraje a replay sedí na zapečetěné sadě – hra se čtením nahraným jednou po
 * otevření pečeti (`read-holdout.cmd` → `readings/holdout.gpt-oss-20b.json`), semínko 1 (jako P56A T13 `botOf`).
 * Přidá klíč `bot` do `final.json`, který před tím zapíše `visibility.mjs`.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p58a/holdout.measure.ts
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import type { Reading } from '../../../src/play/read/schema';

import { ROOT } from '../p56a/rows';

const DIR = join(ROOT, 'p58a');
const SEED = 1;
const MODEL = 'gpt-oss-20b';
const GATE = 80;

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
    return { wins: false, idleLoses: false, replayEqual: false, why: `draft threw: ${(error as Error).message.slice(0, 160)}` };
  }
}

it('robot, idle player and replay on the opened P58A holdout (T9)', async () => {
  const read = JSON.parse(readFileSync(join(DIR, 'readings', `holdout.${MODEL}.json`), 'utf8')) as { readings: { id: string; text: string; reading: Reading | null }[] };
  await loadRapier();
  const rows: ({ id: string } & Awaited<ReturnType<typeof botOf>>)[] = [];
  for (const row of read.readings) rows.push({ id: row.id, ...(await botOf(row.text, row.reading)) });
  const count = (ok: (row: (typeof rows)[number]) => boolean) => rows.filter(ok).length;
  const bot = {
    gate: GATE, seed: SEED, readings: `readings/holdout.${MODEL}.json`,
    wins: count((row) => row.wins), idleLoses: count((row) => row.idleLoses), replayEqual: count((row) => row.replayEqual), of: rows.length,
    failures: rows.filter((row) => row.why !== null).map((row) => `${row.id}: ${row.why}`),
  };
  const path = join(DIR, 'final.json');
  const final = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(path, `${JSON.stringify({ ...final, bot }, null, 1)}\n`);
  console.log(`bot ${bot.wins}/${bot.of} · idle loses ${bot.idleLoses}/${bot.of} · replay ${bot.replayEqual}/${bot.of}`);
}, 60 * 60_000);
