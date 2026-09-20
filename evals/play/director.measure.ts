/**
 * **Jediné živé měření režiséra (P23-B T9).** Běží jen přes
 * `--config vitest.measure.mts`; `vitest.config.mts` příponu `.measure.ts`
 * nesbírá, takže `npm test` sem nikdy nesáhne.
 *
 * Osm bucketových vět balíčku (jedna na archetyp) projde `direct()` proti
 * živé větvi (`WORLDSMITH_MODEL_ENDPOINT=codex-cli`, předplatné) s jedním
 * opravným kolem, a výsledek se zapíše do `director-live.json`. Bez
 * konfigurace se **přeskočí s vysvětlením**, nikdy nepadá. Strop volání
 * (`WORLDSMITH_CALL_CAP`) drží tenhle soubor sám: věta se nezačne, kdyby se
 * s opravným kolem do stropu nevešla, a artefakt pak nese `partial: true`.
 *
 * Co artefakt **nesoudí**: medián ani podíl `authored` – to jsou cíle pro
 * `docs/play/director.md`. `__tests__/director-report.test.ts` drží jen
 * jmenovatel, strop a součty.
 */

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { describe, it } from 'vitest';

import { direct, directorCache } from '@/play/director';
import { memoryAnswerStore } from '@/server/answer-cache';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';

import { packBucketPrompts } from './golden';

export const DIRECTOR_LIVE_SCHEMA = 'play-director-live-v1' as const;

export interface DirectorLivePrompt {
  readonly id: string;
  readonly ms: number;
  readonly source: 'draft' | 'authored' | 'cached';
  readonly archetype: string;
  readonly expectArchetype: string | null;
  readonly archetypeHit: boolean;
  readonly repairRounds: number;
  readonly fallbackReason: string | null;
  readonly bytesOut: number;
  readonly issues: readonly string[];
}

export interface DirectorLiveReport {
  readonly schema: typeof DIRECTOR_LIVE_SCHEMA;
  readonly measuredAt: string;
  readonly model: string;
  readonly effort: string;
  readonly calls: number;
  readonly callCap: number | null;
  readonly partial: boolean;
  readonly partialReason: string | null;
  readonly prompts: readonly DirectorLivePrompt[];
  readonly summary: {
    readonly authored: number;
    readonly draftFallback: number;
    readonly archetypeHits: number;
    readonly medianMs: number;
    readonly p90Ms: number;
  };
}

const REPORT_FILE = fileURLToPath(new URL('./director-live.json', import.meta.url));
const MAX_REPAIR_ROUNDS = 1;

function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)];
}

export function summarize(prompts: readonly DirectorLivePrompt[]): DirectorLiveReport['summary'] {
  const ms = prompts.map((p) => p.ms);
  return {
    authored: prompts.filter((p) => p.source === 'authored').length,
    draftFallback: prompts.filter((p) => p.source === 'draft').length,
    archetypeHits: prompts.filter((p) => p.archetypeHit).length,
    medianMs: percentile(ms, 0.5),
    p90Ms: percentile(ms, 0.9),
  };
}

describe('the director over the eight bucket sentences, live', () => {
  it('writes director-live.json, or explains why it skipped', async () => {
    const config = upstreamConfigFromEnv({ ...process.env, WORLDSMITH_MODEL_ENDPOINT: 'codex-cli' });
    if (config === null) {
      console.warn('[play] director.measure skipped: no live model configured (WORLDSMITH_MODEL_KEY, WORLDSMITH_MODEL_PROFILE, WORLDSMITH_CALL_CAP, WORLDSMITH_USD_PER_MTOK_OUT)');
      return;
    }
    const branch = upstreamBranch(config);
    const cache = directorCache(memoryAnswerStore());
    const prompts: DirectorLivePrompt[] = [];
    let calls = 0;
    let partialReason: string | null = null;

    for (const entry of packBucketPrompts()) {
      if (config.callCap !== null && calls + 1 + MAX_REPAIR_ROUNDS > config.callCap) {
        partialReason = `call cap ${String(config.callCap)} reached after ${String(calls)} calls; ${entry.id} and later not measured`;
        break;
      }
      const started = performance.now();
      const game = await direct(entry.prompt, { branch, cache, now: () => performance.now(), maxRepairRounds: MAX_REPAIR_ROUNDS });
      calls += game.calls;
      const issues: string[] = game.warnings.map((issue) => issue.code);
      if (game.fallbackReason !== null) issues.unshift(game.fallbackReason);
      prompts.push({
        id: entry.id,
        ms: Math.round(performance.now() - started),
        source: game.source,
        archetype: game.spec.archetype,
        expectArchetype: entry.expectArchetype,
        archetypeHit: game.spec.archetype === entry.expectArchetype,
        repairRounds: game.repairRounds,
        fallbackReason: game.fallbackReason,
        bytesOut: Buffer.byteLength(JSON.stringify(game.spec), 'utf8'),
        issues,
      });
      console.warn(`[play] ${entry.id}: ${game.source} in ${String(Math.round(performance.now() - started))} ms, ${String(game.calls)} call(s), ${game.fallbackReason ?? 'ok'}`);
    }

    const report: DirectorLiveReport = {
      schema: DIRECTOR_LIVE_SCHEMA,
      measuredAt: new Date().toISOString(),
      model: config.model,
      effort: config.effort,
      calls,
      callCap: config.callCap,
      partial: partialReason !== null,
      partialReason,
      prompts,
      summary: summarize(prompts),
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  });
});
