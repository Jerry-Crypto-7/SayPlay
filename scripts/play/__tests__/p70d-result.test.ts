/** P70D T5: přepočet slepého soudu a FPS brány (`scripts/play/p70d-result.mjs`). */
import { describe, expect, it } from 'vitest';

// @ts-expect-error – skript .mjs bez deklarací typů
import { SCENES } from '../p70d-shots.mjs';
// @ts-expect-error – skript .mjs bez deklarací typů
import { FPS_DROP_MAX, WIN_MIN, afterSideOf, summarize, verdictOf } from '../p70d-result.mjs';

const IDS: string[] = SCENES.map((scene: { id: string }) => scene.id);
const fps = (value: number) => IDS.map((id) => ({ id, fpsMedian: value }));

describe('P70D blind judge and FPS gate', () => {
  it('places the after shot on both sides across the 8 scenes, the same way every run', () => {
    const sides = IDS.map((id) => afterSideOf(id));
    expect(new Set(sides)).toEqual(new Set(['A', 'B']));
    expect(IDS.map((id) => afterSideOf(id))).toEqual(sides);
  });

  it('maps the judge pick back to before / after through the side', () => {
    expect(verdictOf('A', 'A')).toBe('after');
    expect(verdictOf('B', 'A')).toBe('before');
    expect(verdictOf('B', 'B')).toBe('after');
    expect(verdictOf(undefined, 'A')).toBeNull();
  });

  it('passes with 6 of 8 after wins and no scene losing more than 5 % FPS', () => {
    const verdicts = Object.fromEntries(IDS.map((id, k) => [id, k < WIN_MIN ? 'after' : 'before']));
    const ok = summarize({ scenes: IDS, verdicts, before: fps(30), after: fps(30 * (1 - FPS_DROP_MAX + 0.001)) });
    expect(ok.afterWins).toBe(WIN_MIN);
    expect(ok.pass).toBe(true);
    // Jedna scéna o 5,1 % pomalejší: brána padá, i když soud prošel.
    const slow = summarize({ scenes: IDS, verdicts, before: fps(30), after: IDS.map((id, k) => ({ id, fpsMedian: k === 3 ? 30 * 0.949 : 30 })) });
    expect(slow.rows[3]!.fpsOk).toBe(false);
    expect(slow.pass).toBe(false);
  });

  it('fails on 5 of 8, counts no answer as no win and a missing FPS row as a gate failure', () => {
    const verdicts = Object.fromEntries(IDS.map((id, k) => [id, k < WIN_MIN - 1 ? 'after' : k === IDS.length - 1 ? null : 'before']));
    const five = summarize({ scenes: IDS, verdicts, before: fps(30), after: fps(31) });
    expect(five.afterWins).toBe(WIN_MIN - 1);
    expect(five.judged).toBe(IDS.length - 1);
    expect(five.pass).toBe(false);
    const missing = summarize({ scenes: IDS, verdicts: Object.fromEntries(IDS.map((id) => [id, 'after'])), before: fps(30), after: fps(30).slice(1) });
    expect(missing.rows[0]!.fpsOk).toBe(false);
    expect(missing.pass).toBe(false);
  });
});
