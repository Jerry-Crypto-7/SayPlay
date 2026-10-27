import { describe, expect, it } from 'vitest';

import { xrSupported, xrWanted } from '../flag';

describe('xrWanted', () => {
  it('wants VR only with vr=1', () => {
    expect(xrWanted('https://sayplay.example/play?vr=1')).toBe(true);
    expect(xrWanted('/play/abc?g=1&vr=1')).toBe(true);
    expect(xrWanted('https://sayplay.example/play')).toBe(false);
    expect(xrWanted('/play?vr=0')).toBe(false);
    expect(xrWanted('/play?vr=true')).toBe(false);
  });
});

describe('xrSupported', () => {
  it('is true when the browser supports immersive-vr', async () => {
    expect(await xrSupported({ isSessionSupported: (mode) => Promise.resolve(mode === 'immersive-vr') })).toBe(true);
  });

  it('is false in a browser that does not support it', async () => {
    expect(await xrSupported({ isSessionSupported: () => Promise.resolve(false) })).toBe(false);
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
