/**
 * Fronta režiséra pod náporem (P53 T4), krátká verze zkoušky
 * `scripts/load/director-burst.mjs`: 4 hráči naráz na stropu 1 – všichni dostanou
 * AI verzi, pozdější ve frontě, upstream nikdy víc než jedno volání naráz.
 * Upstream je náhradní na `127.0.0.1` s nahranými odpověďmi; skript si staví
 * vlastní `next start` z hotového buildu, `baseURL` konfigurace nepoužívá.
 */

import { expect, test } from '@playwright/test';

interface BurstGame {
  readonly aiVersion: boolean;
  readonly queuedMax: number;
  readonly reason: string | null;
}

interface BurstRun {
  readonly aiVersions: number;
  readonly modelUnavailable: number;
  readonly upstreamPeak: number;
  readonly upstreamUnknown: number;
  readonly queuedSeen: number;
  readonly games: readonly BurstGame[];
}

test('four players at a ceiling of one all get the full-detail version, one call at a time', async () => {
  test.setTimeout(360_000);
  // Dynamický import: Playwright spec načítá jako CommonJS a statický import ESM skriptu odmítne.
  // @ts-expect-error – skript je čisté ESM bez typů; tvar výsledku říká `BurstRun` níž.
  const { burst } = (await import('../scripts/load/director-burst.mjs')) as { burst: (options: Record<string, number>) => Promise<unknown> };
  const run = (await burst({ players: 4, slots: 1, delayMs: 2_000, port: 3313, spreadMs: 500 })) as BurstRun;
  expect(run.upstreamUnknown).toBe(0);
  expect(run.games.map((game) => game.reason)).not.toContain('MODEL_UNAVAILABLE');
  expect(run.aiVersions).toBe(4);
  expect(run.upstreamPeak).toBe(1);
  // Někdo čekal a stav, který klient polluje, to řekl (`queued`).
  expect(run.queuedSeen).toBeGreaterThan(0);
});
