import { describe, expect, it } from 'vitest';

import { sizeGate } from '../size-check.mjs';

/** Katalogový záznam se dvěma LOD; `replaced` = výměna pod stejným id (T5). */
const asset = (assetId: string, lod1: number, replaced = false) => ({
  assetId,
  lods: [{ level: 0, bytes: lod1 * 2 }, { level: 1, bytes: lod1 }],
  provenance: replaced ? { replacedAt: '2026-10-22' } : {},
});

const base = { bytes: 1000, catalog: { assets: [asset('frog', 500), asset('rock', 300)] } };

describe('sizeGate', () => {
  it('passes when assets grew under the cap and no replaced LOD1 grew', () => {
    expect(sizeGate(base, { bytes: 1150, catalog: { assets: [asset('frog', 400, true), asset('rock', 300)] } })).toEqual({ growth: 0.15, failures: [] });
  });

  it('fails when public/assets grew over 15 %', () => {
    const { failures } = sizeGate(base, { bytes: 1151, catalog: base.catalog });
    expect(failures).toEqual(['public/assets grew 15.1 % (1000 → 1151 B), cap 15 %']);
  });

  it('fails when a replaced model has a bigger LOD1 than the original', () => {
    const { failures } = sizeGate(base, { bytes: 1000, catalog: { assets: [asset('frog', 501, true), asset('rock', 300)] } });
    expect(failures).toEqual(['frog: LOD1 501 B > original 500 B']);
  });

  it('ignores a bigger LOD1 of a model that was not replaced', () => {
    expect(sizeGate(base, { bytes: 1000, catalog: { assets: [asset('frog', 500), asset('rock', 900)] } }).failures).toEqual([]);
  });
});
