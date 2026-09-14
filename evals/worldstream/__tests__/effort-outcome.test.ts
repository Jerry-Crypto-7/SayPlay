import { describe, expect, it } from 'vitest';

import { classifyOutcome } from '../effort-outcome';

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
