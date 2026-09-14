import { describe, expect, it } from 'vitest';

import { buildKey, pickWinner, renderSheet, reveal } from '../effort-sheet.mjs';

/**
 * P16 T4 – prohozený klíč by korunoval špatnou variantu a arch by vypadal
 * úplně stejně. Pinuje se proto cesta fotka → písmeno → hodnocení → varianta
 * a pravidlo, které z hodnocení vybere vítěze.
 */
const VARIANTS = ['luna', 'sol', 'astra-low', 'astra-medium', 'astra-high', 'astra-xhigh', 'astra-max'];
const SENTENCES = [
  { id: 't1', prompt: 'a floating library in the clouds with spiral staircases and glowing books' },
  { id: 'c04', prompt: 'A brutalist observatory, one dome on three splayed legs, on a windswept plateau.' },
];
/** Fotka poznatelná podle varianty, ale bez jejího jména v textu. */
const photoOf = (variant: string, sentence: string) => `data:image/jpeg;base64,${Buffer.from(`${VARIANTS.indexOf(variant)}-${sentence}`).toString('base64')}`;

function sheetFor(key: ReturnType<typeof buildKey>, missing: { variant: string; sentence: string } | null = null) {
  return renderSheet(SENTENCES.map((sentence) => ({
    id: sentence.id,
    prompt: sentence.prompt,
    entries: Object.entries(key.sections[sentence.id]!).map(([letter, variant]) => ({
      letter,
      photo: missing?.variant === variant && missing.sentence === sentence.id ? null : photoOf(variant, sentence.id),
    })),
  })));
}

describe('the blind key', () => {
  it('shows under each letter the photo of the variant the key names', () => {
    const key = buildKey(VARIANTS, SENTENCES.map((sentence) => sentence.id), 7);
    const html = sheetFor(key);
    for (const sentence of SENTENCES)
      for (const [letter, variant] of Object.entries(key.sections[sentence.id]!)) {
        const cell = html.match(new RegExp(`data-section="${sentence.id}" data-letter="${letter}"[^>]*>[\\s\\S]*?</figure>`))?.[0];
        expect(cell, `${sentence.id} ${letter}`).toContain(photoOf(variant, sentence.id));
      }
  });

  it('returns every rating to the variant that earned it', () => {
    const key = buildKey(VARIANTS, SENTENCES.map((sentence) => sentence.id), 7);
    const score = (variant: string) => (VARIANTS.indexOf(variant) % 5) + 1;
    const ratings = Object.fromEntries(SENTENCES.map((sentence) => [sentence.id,
      Object.fromEntries(Object.entries(key.sections[sentence.id]!).map(([letter, variant]) => [letter, score(variant)]))]));
    const back = reveal(key, ratings);
    for (const variant of VARIANTS) expect(back[variant]).toEqual([score(variant), score(variant)]);
  });

  it('actually shuffles, differently per sentence and per seed', () => {
    const key = buildKey(VARIANTS, ['t1', 'c04'], 7);
    expect(Object.values(key.sections.t1!)).not.toEqual(VARIANTS);
    expect(Object.values(key.sections.t1!)).not.toEqual(Object.values(key.sections.c04!));
    expect(buildKey(VARIANTS, ['t1'], 8).sections.t1).not.toEqual(key.sections.t1);
    expect([...Object.values(key.sections.t1!)].sort()).toEqual([...VARIANTS].sort());
  });

  it('refuses a rating for a letter the key does not have', () => {
    const key = buildKey(VARIANTS, ['t1'], 7);
    expect(() => reveal(key, { t1: { H: 5 } })).toThrow(/H/);
  });

  it('names no variant, model or effort anywhere in the sheet', () => {
    const html = sheetFor(buildKey(VARIANTS, SENTENCES.map((sentence) => sentence.id), 7), { variant: 'astra-high', sentence: 't1' });
    expect(html).not.toMatch(/\b(astra|luna|sol|low|medium|high|xhigh|gpt)\b/i);
    expect(html).toContain('world did not arrive');
  });
});

describe('pickWinner', () => {
  const stat = (variant: string, ratings: number[], swapMs: number[], failures = 0) => ({ variant, ratings, swapMs, failures });
  const fast = [60_000, 70_000, 80_000];

  it('takes the highest mean rating', () => {
    expect(pickWinner([stat('a', [3, 3], fast), stat('b', [4, 5], fast), stat('c', [2, 5], fast)])).toBe('b');
  });

  it('drops a variant whose p95 time is over 240 s, however well rated', () => {
    expect(pickWinner([stat('slow', [5, 5], [60_000, 241_000]), stat('ok', [3, 3], fast)])).toBe('ok');
    expect(pickWinner([stat('edge', [5, 5], [60_000, 240_000]), stat('ok', [3, 3], fast)])).toBe('edge');
  });

  it('allows one failure out of eight and drops two', () => {
    expect(pickWinner([stat('one', [5, 5], fast, 1), stat('ok', [3, 3], fast)])).toBe('one');
    expect(pickWinner([stat('two', [5, 5], fast, 2), stat('ok', [3, 3], fast)])).toBe('ok');
  });

  it('breaks a tie on the lower median time', () => {
    expect(pickWinner([stat('a', [4, 4], [90_000, 100_000, 110_000]), stat('b', [4, 4], [50_000, 60_000, 200_000])])).toBe('b');
  });

  it('names nobody when every variant is dropped', () => {
    expect(pickWinner([stat('slow', [5], [300_000]), stat('broken', [5], fast, 3)])).toBeNull();
  });
});
