import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frozenFiles, qualityRoot, readQualityCases, verifyQualityCorpus } from './corpus';

describe('P20 frozen acceptance contract', () => {
  it('detects changed criteria or examples while allowing Windows line endings', () => {
    const root = mkdtempSync(join(tmpdir(), 'p20-corpus-'));
    try {
      for (const file of [...frozenFiles, 'MANIFEST.lock']) copyFileSync(join(qualityRoot, file), join(root, file));
      const protocol = readFileSync(join(root, 'protocol.json'), 'utf8').replace(/\r\n/g, '\n');
      writeFileSync(join(root, 'protocol.json'), protocol.replace(/\n/g, '\r\n'));
      expect(() => verifyQualityCorpus(root)).not.toThrow();
      writeFileSync(join(root, 'protocol.json'), protocol.replace('90000', '90001'));
      expect(() => verifyQualityCorpus(root)).toThrow('protocol.json');
      writeFileSync(join(root, 'protocol.json'), protocol);
      writeFileSync(join(root, 'holdout.json'), '[]');
      expect(() => verifyQualityCorpus(root)).toThrow('holdout.json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps the pre-tuning dataset and rubric unchanged', () => {
    expect(verifyQualityCorpus).not.toThrow();
    const all = readQualityCases('all');
    expect(readQualityCases('development')).toHaveLength(10);
    expect(readQualityCases('holdout')).toHaveLength(20);
    expect(new Set(all.map((c) => c.id)).size).toBe(30);
    expect(new Set(all.map((c) => c.prompt)).size).toBe(30);
    for (const entry of all) {
      expect(entry.heroObjects.length).toBeGreaterThan(0);
      expect(entry.visibleBeat.length).toBeGreaterThan(0);
    }
    const holdout = readQualityCases('holdout');
    for (const category of ['interior', 'outdoor', 'fantastic', 'unusual-object'])
      expect(holdout.filter((c) => c.category === category)).toHaveLength(5);
  });

  it('requires observable branch differences with identical inputs and no structural migration', () => {
    const cases = JSON.parse(readFileSync(`${qualityRoot}a4-cases.json`, 'utf8')) as {
      kind: string; inputs: string[]; expectedOriginal: string; expectedChanged: string; structuralChangesAllowed: boolean;
    }[];
    expect(cases).toHaveLength(10);
    expect(cases.filter((c) => c.kind !== 'timer').length).toBeGreaterThanOrEqual(6);
    for (const entry of cases) {
      expect(entry.inputs.length).toBeGreaterThan(0);
      expect(entry.expectedChanged).not.toBe(entry.expectedOriginal);
      expect(entry.structuralChangesAllowed).toBe(false);
    }
  });
});
