import { describe, expect, it } from 'vitest';

import { type XrSystemLike, fpsHudWanted, xrGateOpen, xrSupported, xrWanted } from '../flag';

const vr = (supported: boolean): XrSystemLike => ({ isSessionSupported: (mode) => Promise.resolve(supported && mode === 'immersive-vr') });

describe('fpsHudWanted', () => {
  it('shows the FPS panel only with vrhud=1', () => {
    expect(fpsHudWanted('http://localhost:3165/play?vr=1&vrhud=1')).toBe(true);
    expect(fpsHudWanted('http://localhost:3165/play?vrhud=1')).toBe(true);
    expect(fpsHudWanted('http://localhost:3165/play?vr=1')).toBe(false);
    expect(fpsHudWanted('/play?vrhud=0')).toBe(false);
  });
});

describe('xrWanted', () => {
  it('wants VR on every address unless vr=0 switches it off', () => {
    expect(xrWanted('https://sayplay.example/play')).toBe(true);
    expect(xrWanted('/play/abc?g=1')).toBe(true);
    expect(xrWanted('https://sayplay.example/play?vr=1')).toBe(true);
    expect(xrWanted('/play?vr=true')).toBe(true);
    expect(xrWanted('/play?vr=0')).toBe(false);
    expect(xrWanted('/play/abc?g=1&vr=0')).toBe(false);
  });
});

describe('xrSupported', () => {
  it('is true when the browser supports immersive-vr', async () => {
    expect(await xrSupported(vr(true))).toBe(true);
  });

  it('is false in a browser that does not support it', async () => {
    expect(await xrSupported(vr(false))).toBe(false);
  });

  it('is false without navigator.xr', async () => {
    expect(await xrSupported(undefined)).toBe(false);
  });

  it('is false when isSessionSupported throws or rejects', async () => {
    expect(
      await xrSupported({
        isSessionSupported: () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBe(false);
    expect(await xrSupported({ isSessionSupported: () => Promise.reject(new Error('NotAllowed')) })).toBe(false);
  });
});

describe('xrGateOpen', () => {
  it('opens for a headset browser on a plain address, without ?vr=1', async () => {
    expect(await xrGateOpen('https://sayplay.example/play', vr(true))).toBe(true);
    expect(await xrGateOpen('/play/abc?g=1', vr(true))).toBe(true);
  });

  it('stays shut on a phone or desktop without immersive-vr, whatever the address says', async () => {
    expect(await xrGateOpen('https://sayplay.example/play', vr(false))).toBe(false);
    expect(await xrGateOpen('https://sayplay.example/play?vr=1', vr(false))).toBe(false);
    expect(await xrGateOpen('https://sayplay.example/play', undefined)).toBe(false);
  });

  it('stays shut with ?vr=0 even in a headset, and then never asks the browser', async () => {
    let asked = 0;
    const spy: XrSystemLike = {
      isSessionSupported: () => {
        asked += 1;
        return Promise.resolve(true);
      },
    };
    expect(await xrGateOpen('/play?vr=0', spy)).toBe(false);
    expect(asked).toBe(0);
  });
});
