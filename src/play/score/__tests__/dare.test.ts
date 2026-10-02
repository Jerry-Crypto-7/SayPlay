import { describe, expect, it } from 'vitest';

import { ARCADE_LIMITS, type InputEvent } from '@/play/arcade/contract';
import { memoryVersionStore } from '@/play/version';

import { packInputs, unpackInputs } from '../dare';

/** Zhuštěný záznam výzvy (P36B T5) a úložiště výzev; route přijde v další úloze. */
describe('packInputs / unpackInputs', () => {
  const held: InputEvent[] = Array.from({ length: 1700 }, (_, i) => ({ tick: 100 + i, buttons: 0, axis: 1000 }));
  const taps: InputEvent[] = [
    { tick: 0, buttons: 1, axis: 0 },
    { tick: 5, buttons: 1, axis: 0 },
    { tick: 6, buttons: 2, axis: 0 },
  ];

  it('držená osa je jeden běh a rozbalí se na tytéž tiky', () => {
    expect(packInputs(held)).toEqual([100, 1700, 0, 1000]);
    expect(unpackInputs(packInputs(held))).toEqual(held);
    expect(unpackInputs(packInputs(taps))).toEqual(taps);
  });

  it('nejhorší případ (jiná osa každý tik, 90 s) se vejde pod strop těla 64 kB', () => {
    const noisy: InputEvent[] = Array.from({ length: ARCADE_LIMITS.maxTicks }, (_, i) => ({ tick: i, buttons: 0, axis: -999 + (i % 1999) }));
    expect(JSON.stringify({ inputs: packInputs(noisy) }).length).toBeLessThan(64 * 1024);
  });

  it('odmítne běh za horizontem, zápornou mezeru, cizí tlačítka, osu mimo rozsah a nečísla', () => {
    expect(typeof unpackInputs([ARCADE_LIMITS.maxTicks - 1, 1, 1, 0])).toBe('object');
    expect(typeof unpackInputs([ARCADE_LIMITS.maxTicks, 1, 1, 0])).toBe('string');
    expect(typeof unpackInputs([-1, 1, 1, 0])).toBe('string');
    expect(typeof unpackInputs([0, 0, 1, 0])).toBe('string');
    expect(typeof unpackInputs([0, 1, 1 << 12, 0])).toBe('string');
    expect(typeof unpackInputs([0, 1, 0, 1001])).toBe('string');
    expect(typeof unpackInputs([0, 1, 0.5, 0])).toBe('string');
    expect(typeof unpackInputs([0, 1, 1])).toBe('string');
    expect(typeof unpackInputs('0,1,1,0')).toBe('string');
  });
});

describe('úložiště výzev', () => {
  const dare = { dareId: 'a'.repeat(32), versionId: 'b'.repeat(16), score: 120, ticks: 900, hash: 'c0ffee', liveChanges: 0, createdAt: '2026-10-02T00:00:00.000Z' };

  it('zapíše jednou, přečte zpátky; neznámá výzva je null', async () => {
    const store = memoryVersionStore();
    expect(await store.putDare(dare)).toBe('stored');
    expect(await store.putDare({ ...dare, score: 9999 })).toBe('exists');
    expect(await store.getDare(dare.dareId)).toEqual(dare);
    expect(await store.getDare('f'.repeat(32))).toBeNull();
  });

  it('denní strop výzev zastaví zápis', async () => {
    const store = memoryVersionStore({ ttlSeconds: 60, dailyCap: 10, dareDailyCap: 1 }, () => 0);
    expect(await store.putDare(dare)).toBe('stored');
    // Týž záznam podruhé strop neubírá – jinak by jeden opakovaný požadavek zavřel výzvy všem.
    expect(await store.putDare(dare)).toBe('exists');
    expect(await store.putDare({ ...dare, dareId: 'd'.repeat(32) })).toBe('quota');
  });

  it('opakovaný zápis existující výzvy denní strop nespotřebuje', async () => {
    const store = memoryVersionStore({ ttlSeconds: 60, dailyCap: 10, dareDailyCap: 2 }, () => 0);
    expect(await store.putDare(dare)).toBe('stored');
    for (let i = 0; i < 5; i += 1) expect(await store.putDare(dare)).toBe('exists');
    expect(await store.putDare({ ...dare, dareId: 'd'.repeat(32) })).toBe('stored');
  });
});
