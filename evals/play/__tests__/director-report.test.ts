/**
 * Artefakt živého měření režiséra (P23-B T9). Vymyšlené číslo vypadá stejně
 * jako naměřené – test proto drží jen to, co jde ověřit bez modelu:
 * jmenovatel (8 vět, nebo `partial` s důvodem), strop volání, tvar a součty
 * spočítané z položek. Medián a podíl `authored` **nesoudí** – ty čte
 * `docs/play/director.md`.
 *
 * Záměrně nic neimportuje z `director.measure.ts`: import by zaregistroval
 * jeho `describe` do běžné sady a živý běh by se spustil při každém `npm test`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHETYPE_IDS } from '@/play/registry';

import { packBucketPrompts } from '../golden';

const report = JSON.parse(readFileSync(fileURLToPath(new URL('../director-live.json', import.meta.url)), 'utf8')) as {
  schema: string;
  measuredAt: string;
  model: string;
  effort: string;
  calls: number;
  callCap: number | null;
  partial: boolean;
  partialReason: string | null;
  prompts: { id: string; ms: number; source: string; archetype: string; expectArchetype: string | null; archetypeHit: boolean; repairRounds: number; fallbackReason: string | null; bytesOut: number; issues: string[] }[];
  summary: { authored: number; draftFallback: number; archetypeHits: number; medianMs: number; p90Ms: number };
};

function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)];
}

describe('director-live.json', () => {
  it('is the v1 schema over the eight bucket sentences, or partial with a reason', () => {
    expect(report.schema).toBe('play-director-live-v1');
    expect(Number.isNaN(Date.parse(report.measuredAt))).toBe(false);
    expect(report.model.length).toBeGreaterThan(0);
    const expected = packBucketPrompts().map((p) => p.id);
    if (report.partial) {
      expect(report.partialReason).toMatch(/call cap/);
      expect(report.prompts.map((p) => p.id)).toEqual(expected.slice(0, report.prompts.length));
    } else {
      expect(report.partialReason).toBeNull();
      expect(report.prompts.map((p) => p.id)).toEqual(expected);
      expect(report.prompts).toHaveLength(8);
    }
  });

  it('never exceeds the call cap, and each sentence cost 0..2 calls', () => {
    expect(report.calls).toBeLessThanOrEqual(12);
    if (report.callCap !== null) expect(report.calls).toBeLessThanOrEqual(report.callCap);
    expect(report.calls).toBeGreaterThanOrEqual(report.prompts.filter((p) => p.source !== 'cached').length);
    expect(report.calls).toBeLessThanOrEqual(report.prompts.length * 2);
  });

  it('every item is well-formed and archetypeHit follows from the two archetype fields', () => {
    for (const item of report.prompts) {
      expect(['draft', 'authored', 'cached']).toContain(item.source);
      expect(ARCHETYPE_IDS).toContain(item.archetype);
      expect(item.archetypeHit).toBe(item.archetype === item.expectArchetype);
      expect(item.ms).toBeGreaterThan(0);
      expect(item.bytesOut).toBeGreaterThan(0);
      expect(item.repairRounds).toBeGreaterThanOrEqual(0);
      expect(item.repairRounds).toBeLessThanOrEqual(1);
      expect(item.source === 'draft').toBe(item.fallbackReason !== null);
      if (item.fallbackReason !== null) expect(item.issues[0]).toBe(item.fallbackReason);
    }
  });

  it('summary is recomputed from the items', () => {
    const ms = report.prompts.map((p) => p.ms);
    expect(report.summary).toEqual({
      authored: report.prompts.filter((p) => p.source === 'authored').length,
      draftFallback: report.prompts.filter((p) => p.source === 'draft').length,
      archetypeHits: report.prompts.filter((p) => p.archetypeHit).length,
      medianMs: percentile(ms, 0.5),
      p90Ms: percentile(ms, 0.9),
    });
  });
});
