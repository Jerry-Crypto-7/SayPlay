import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyOutcome, recordOutcome, type OutcomeRecord } from '../effort-outcome';

const record = (variant: string, id: string, outcome: OutcomeRecord['outcome']): OutcomeRecord => ({
  variant, model: 'gpt-6-astra', effort: 'high', id, outcome, ms: 1000, photo: `${variant}-${id}.jpg`, submitted: '2026-09-15T10:00:00Z',
});

/** Mezery z revize testů před `/ship` 15. 9. 2026 (`ship-testgaps`). */
describe('recordOutcome', () => {
  it('replaces a repeated variant and sentence instead of counting it twice', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'effort-outcome-')), 'results.json');
    recordOutcome(file, record('astra-high', 't1', 'timeout'));
    recordOutcome(file, record('luna', 't1', 'swap'));
    recordOutcome(file, record('astra-high', 't1', 'swap'));
    const { records } = JSON.parse(readFileSync(file, 'utf8')) as { records: OutcomeRecord[] };
    expect(records.map((kept) => `${kept.variant}:${kept.id}:${kept.outcome}`)).toEqual(['luna:t1:swap', 'astra-high:t1:swap']);
    expect(existsSync(`${file}.lock`), 'the lock outlived the write').toBe(false);
  });

  it('releases the lock when the write fails', () => {
    // Adresář místo souboru: čtení spadne uvnitř zámku.
    const file = join(mkdtempSync(join(tmpdir(), 'effort-outcome-')), 'results.json');
    mkdirSync(file);
    expect(() => recordOutcome(file, record('luna', 't1', 'swap'))).toThrow();
    expect(existsSync(`${file}.lock`), 'a failed write left the lock held for every later run').toBe(false);
  });
});

/**
 * P16 T2 – tiché selhání dějství II vypadá na plátně jako úspěch: připravený
 * svět zůstane a hláška „writing" jen zmizí. Kdyby se počítalo jako výměna,
 * varianta by v porovnání vyšla lépe, než je.
 */
describe('classifyOutcome', () => {
  it('counts a live world as a swap', () => {
    expect(classifyOutcome({ sawWriting: true, writingGone: true, sawLive: true })).toBe('swap');
  });

  it('counts a live world as a swap even when the model wrote the first sentence itself', () => {
    expect(classifyOutcome({ sawWriting: false, writingGone: false, sawLive: true })).toBe('swap');
  });

  it('never counts a vanished "writing" without a live world as a swap', () => {
    expect(classifyOutcome({ sawWriting: true, writingGone: true, sawLive: false })).toBe('silent-fail');
  });

  it('calls a model still writing at the deadline a timeout', () => {
    expect(classifyOutcome({ sawWriting: true, writingGone: false, sawLive: false })).toBe('timeout');
  });

  it('calls a second act that never started no-start', () => {
    expect(classifyOutcome({ sawWriting: false, writingGone: false, sawLive: false })).toBe('no-start');
  });
});
