/**
 * Držení kresby při výměně scény (T13a, `holdDrawing`): plátno nekreslí, dokud se nepřeloží programy nové scény,
 * a pak kreslí dál. Kdyby se kreslení nevrátilo, kolo řetězu by stálo na posledním snímku předchozího – e2e to nepozná,
 * protože kola posouvá sondou bez plátna.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type DrawLoop, HOLD_CAP_MS, holdDrawing } from '../StageHost';

function loop(frameloop: DrawLoop['frameloop'] = 'always'): { state: DrawLoop; get: () => DrawLoop } {
  const state = {
    frameloop,
    internal: { frames: 2 },
    setFrameloop(next: DrawLoop['frameloop']) {
      state.frameloop = next;
    },
  };
  return { state, get: () => state };
}

/** Slib, který test dokončí sám. */
function later(): { promise: Promise<void>; done: () => void } {
  let done = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}

describe('holdDrawing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops drawing, compiles in a later task and draws again once the programs are ready', async () => {
    const { state, get } = loop('always');
    const compiled = later();
    const ready = vi.fn(() => compiled.promise);
    holdDrawing(get, ready);
    expect(state.frameloop).toBe('never');
    expect(state.internal.frames).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledOnce();
    expect(state.frameloop).toBe('never');
    compiled.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.frameloop).toBe('always');
  });

  it('draws again at the cap when compiling never finishes, and on cleanup', async () => {
    const capped = loop('demand');
    holdDrawing(capped.get, () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(HOLD_CAP_MS - 1);
    expect(capped.state.frameloop).toBe('never');
    await vi.advanceTimersByTimeAsync(1);
    expect(capped.state.frameloop).toBe('demand');

    const left = loop('always');
    const release = holdDrawing(left.get, () => new Promise(() => undefined));
    release();
    expect(left.state.frameloop).toBe('always');
  });

  it('leaves a frameloop someone else set meanwhile, and does not hold a loop that is not drawing', async () => {
    const { state, get } = loop('always');
    const compiled = later();
    holdDrawing(get, () => compiled.promise);
    state.setFrameloop('demand');
    await vi.advanceTimersByTimeAsync(0);
    compiled.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.frameloop).toBe('demand');

    const idle = loop('never');
    const ready = vi.fn(() => Promise.resolve());
    holdDrawing(idle.get, ready);
    await vi.advanceTimersByTimeAsync(HOLD_CAP_MS);
    expect(ready).not.toHaveBeenCalled();
    expect(idle.state.frameloop).toBe('never');
  });
});
