/**
 * Volba metody mapování P44C (T4). „stab“ → `collect` místo `fight` projde každou kontrolou tvaru,
 * proto test hlídá vybranou variantu na pevných párech a že config nese právě ji.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Run {
  readonly variant: 'A' | 'B' | 'C';
  readonly wordnet: number | null;
  readonly embed: number | null;
  readonly precision: number;
  readonly coverage: number;
  readonly falseMapped: number;
}

const method = JSON.parse(readFileSync('evals/play/p44c/method.json', 'utf8')) as {
  oewnSha256: string;
  gate: { precision: number; falseMapped: number };
  gold: { pairs: number; negatives: number };
  selected: Run & { passesGate: boolean };
  variants: Run[];
  probes: Record<string, { axis: string | null; hero: string | null }>;
};
const config = JSON.parse(readFileSync('scripts/vocab/config.json', 'utf8')) as {
  oewn: { sha256: string };
  method: { variant: string; wordnet: number | null; embed: number | null; passesGate: boolean };
};

describe('P44C mapping method', () => {
  it('measured all three variants on the whole gold set against the pinned OEWN', () => {
    expect(new Set(method.variants.map((run) => run.variant))).toEqual(new Set(['A', 'B', 'C']));
    expect(method.gold.pairs).toBeGreaterThanOrEqual(200);
    expect(method.gold.negatives).toBeGreaterThanOrEqual(40);
    expect(method.oewnSha256).toBe(config.oewn.sha256);
  });

  it('records in config exactly the variant and thresholds it selected', () => {
    const { variant, wordnet, embed, passesGate } = method.selected;
    expect(config.method).toEqual({ variant, wordnet, embed, passesGate });
  });

  it('selects a variant that clears the gate: precision at least 90 % and at most 2 false negatives', () => {
    expect(method.gate).toEqual({ precision: 0.9, falseMapped: 2 });
    expect(method.selected.passesGate).toBe(true);
    expect(method.selected.precision).toBeGreaterThanOrEqual(0.9);
    expect(method.selected.falseMapped).toBeLessThanOrEqual(2);
    const better = method.variants.filter((run) => run.precision >= 0.9 && run.falseMapped <= 2 && run.coverage > method.selected.coverage);
    expect(better).toEqual([]);
  });

  it('maps the fixed probes the way a player would expect', () => {
    expect(method.probes.stab?.axis).toBe('action:fight');
    expect(method.probes.sprint?.axis).toBe('move:run');
    expect(method.probes.lug?.axis).toBe('action:deliver');
    expect(method.probes.explain).toEqual({ axis: null, hero: null });
  });
});
