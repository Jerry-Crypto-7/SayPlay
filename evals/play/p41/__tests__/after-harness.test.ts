import { describe, expect, it, vi } from 'vitest';
import { failedMeasurement, prepareDrafting } from '../after-harness';

describe('after measurement setup and failure accounting', () => {
  it('awaits cold physics before the first synchronous composing draft', async () => {
    let ready = false;
    const draft = vi.fn((sentence: string) => { if (!ready) throw new Error('cold physics'); return sentence; });
    const harness = await prepareDrafting(async () => { await Promise.resolve(); ready = true; }, draft);
    expect(draft).not.toHaveBeenCalled();
    expect(harness.startupError).toBeNull();
    expect(harness.draft('kick the ball')).toBe('kick the ball');
  });
  it('records startup failure and never drafts against a missing dependency', async () => {
    const draft = vi.fn();
    const harness = await prepareDrafting(async () => { throw new Error('WASM unavailable'); }, draft);
    expect(harness.startupError).toContain('WASM unavailable');
    expect(() => harness.draft()).toThrow('Measurement startup failed');
    expect(draft).not.toHaveBeenCalled();
  });
  it('counts an unbuilt run as failed preservation, not as published silent omissions', () => {
    const triples = [{ actor: 'hero', verb: 'ball' as const, object: null }];
    expect(failedMeasurement(triples)).toEqual({ preserved: false, total: 1, proved: 0, missing: triples, silent: [] });
    expect(failedMeasurement([]).preserved).toBe(false);
  });
});
