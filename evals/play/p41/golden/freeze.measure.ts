/**
 * Generátor zmrazení P41 T3 – jediná cesta:
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p41/golden/freeze.measure.ts
 *
 * Zapíše `genres.json` (spec, hash světa a brána publikace každé varianty
 * a semínka), `replays.json` (vstup robota a jeho výsledek) a `stored.json`
 * (uložené hry z `data/play/store` s přehráním + fixtury, které musí zůstat
 * odmítnuté). Pustit jen nad kódem, který se zmrazuje – přepis souborů je
 * vědomé „tohle je nová pravda“, ne oprava červeného testu.
 */

import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  GOLDEN_FILES,
  type MustReject,
  PRIVATE_PATTERNS,
  type ReplayRecord,
  SEEDS,
  type StoredGame,
  type VariantRecord,
  botReplay,
  decodeStored,
  deriveStored,
  guarded,
  mustRejectFiles,
  readStoreRecords,
  rejectVerdict,
  replayKey,
  runVariant,
  stableJson,
  variants,
} from './freeze';

describe('P41 T3 golden freeze (generator)', () => {
  it('writes genres.json and replays.json', () => {
    const started = Date.now();
    const records: VariantRecord[] = [];
    const replays: Record<string, ReturnType<typeof guarded<ReplayRecord>>> = {};
    for (const variant of variants()) {
      const run = runVariant(variant, { compiledSeeds: SEEDS });
      records.push(run.record);
      for (const seed of SEEDS) {
        const world = run.worlds.get(seed);
        if (world !== undefined) replays[replayKey(variant.id, seed)] = guarded(() => botReplay(world, replayKey(variant.id, seed)));
      }
    }
    writeFileSync(GOLDEN_FILES.genres, stableJson({ schema: 'p41-golden-genres.v1', seeds: [...SEEDS], variants: records }));
    writeFileSync(GOLDEN_FILES.replays, stableJson({ schema: 'p41-golden-replays.v1', replays }));
    const outcomes = Object.values(replays).reduce<Record<string, number>>((count, run) => {
      const outcome = 'outcome' in run ? run.outcome : 'THROWN';
      return { ...count, [outcome]: (count[outcome] ?? 0) + 1 };
    }, {});
    console.log(`[p41 golden] ${records.length} variants, ${Object.keys(replays).length} replays ${JSON.stringify(outcomes)}, ${records.filter((record) => record.read?.ok !== true).length} rejected, ${Date.now() - started} ms`);
    expect(records.length).toBeGreaterThan(0);
  });

  it('writes stored.json', async () => {
    const records = readStoreRecords();
    const decoded = await decodeStored(records);
    const games: StoredGame[] = [];
    const dropped: string[] = [];
    for (const { file, record } of records) {
      const versionId = /([a-f0-9]{32})$/.exec(record.key)?.[1] as string;
      const game = decoded.get(versionId);
      if (game === null || game === undefined) throw new Error(`${file}: stored game ${versionId} does not decode`);
      const leak = PRIVATE_PATTERNS.find((pattern) => pattern.test(JSON.stringify(record)));
      if (leak !== undefined) {
        dropped.push(`${versionId} (${String(leak)})`);
        continue;
      }
      games.push({ file, versionId, record, game, derived: await deriveStored(game, `stored ${versionId}`) });
    }
    const mustReject = mustRejectFiles().map((file): MustReject => {
      const verdict = rejectVerdict(file);
      if ('reader' in verdict) return verdict;
      throw new Error(`${file} is not rejected today – it cannot be frozen as mustReject`);
    });
    writeFileSync(GOLDEN_FILES.stored, stableJson({ schema: 'p41-golden-stored.v1', games, mustReject }));
    console.log(`[p41 golden] stored: ${games.length} games (dropped ${dropped.length}: ${dropped.join(', ') || 'none'}), mustReject ${mustReject.length}`);
    expect(games.length + dropped.length).toBe(records.length);
  });
});
