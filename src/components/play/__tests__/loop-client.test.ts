import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Okamžitý odchod (P40 T4): server konec relace nevidí, takže `bounce` posílá
 * klient – když hráč od zobrazené hry odejde další hrou nebo zavřenou stránkou
 * bez jediného vstupu. Odchod od hrané hry `bounce` není.
 */

const A = 'a1b2c3d4e5f60718';
const B = 'b1b2c3d4e5f60718';

let beacons: Blob[] = [];
let onPagehide: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  beacons = [];
  onPagehide = [];
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    location: { search: '', pathname: '/play' },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'pagehide') onPagehide.push(listener);
    },
  });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
  vi.stubGlobal('navigator', { sendBeacon: (_url: string, body: Blob) => beacons.push(body) > 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sent(): Promise<string[]> {
  return Promise.all(
    beacons.map(async (blob) => {
      const event = JSON.parse(await blob.text()) as { name: string; versionId: string };
      return `${event.name} ${event.versionId === A ? 'A' : 'B'}`;
    }),
  );
}

const leave = (): void => {
  for (const listener of onPagehide) listener();
};

describe('bounce', () => {
  it('next game without a single input bounces the game being left, once', async () => {
    const { loopEvent, loopImpression } = await import('../loop-client');
    loopImpression(A);
    loopEvent('next_game', A);
    loopEvent('next_game', A);
    expect(await sent()).toEqual(['impression A', 'bounce A', 'next_game A', 'next_game A']);
  });

  it('a game the player touched is not a bounce, by next game or by closing the page', async () => {
    const { loopEvent, loopImpression } = await import('../loop-client');
    loopImpression(A);
    loopEvent('first_input', A);
    loopEvent('next_game', A);
    loopImpression(B);
    loopEvent('first_input', B);
    leave();
    expect((await sent()).filter((line) => line.startsWith('bounce'))).toEqual([]);
  });

  it('a finished run or Play again is not a bounce, even when the swallowed first tap sent no first_input', async () => {
    const { loopEvent, loopImpression } = await import('../loop-client');
    loopImpression(A);
    loopEvent('lose', A);
    loopEvent('restart', A);
    loopEvent('next_game', A);
    loopImpression(B);
    loopEvent('win', B);
    leave();
    expect((await sent()).filter((line) => line.startsWith('bounce'))).toEqual([]);
  });

  it('closing the page bounces only the last game shown, if untouched', async () => {
    const { loopEvent, loopImpression } = await import('../loop-client');
    loopImpression(A);
    loopEvent('first_input', A);
    loopImpression(B);
    leave();
    leave();
    expect((await sent()).filter((line) => line.startsWith('bounce'))).toEqual(['bounce B']);
    expect(onPagehide).toHaveLength(1);
  });
});
