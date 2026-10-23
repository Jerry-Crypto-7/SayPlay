/**
 * Přehrávání vlastní hudby a zvuků (P29D T5) nad falešným `AudioContext`:
 * před gestem se nic nestahuje, dekódovaný soubor přebije ZzFX, chybějící
 * soubor ZzFX vrátí, smyčka respektuje ztlumení a `PLAY_MUSIC=off`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Source = { buffer: unknown; loop: boolean; started: number; stopped: number; connect: () => void; disconnect: () => void; start: () => void; stop: () => void };

class FakeContext {
  static last: FakeContext | null = null;
  state: 'suspended' | 'running' = 'suspended';
  sources: Source[] = [];
  gains: { gain: { value: number; ramps: number[] } }[] = [];
  created = 0;
  readonly destination = {};
  private listeners: (() => void)[] = [];
  constructor() {
    FakeContext.last = this;
  }
  addEventListener(_: string, listener: () => void) {
    this.listeners.push(listener);
  }
  resume() {
    this.state = 'running';
    for (const listener of this.listeners) listener();
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number) {
    this.created += 1;
    return { zzfx: true, length, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource(): Source {
    const source: Source = {
      buffer: null,
      loop: false,
      started: 0,
      stopped: 0,
      connect: () => {},
      disconnect: () => {},
      start: () => {
        source.started += 1;
      },
      stop: () => {
        source.stopped += 1;
      },
    };
    this.sources.push(source);
    return source;
  }
  readonly currentTime = 0;
  /** Rampa nastaví cílovou hodnotu hned (test čas nežene); naplánované kroky se zapisují do `ramps`. */
  createGain() {
    const param = {
      value: 1,
      ramps: [] as number[],
      cancelScheduledValues: () => {},
      setValueAtTime: () => {},
      linearRampToValueAtTime: (value: number) => {
        param.ramps.push(value);
        param.value = value;
      },
    };
    const gain = { gain: param, connect: () => {}, disconnect: () => {} };
    this.gains.push(gain);
    return gain;
  }
  decodeAudioData(data: ArrayBuffer) {
    return Promise.resolve({ decoded: new TextDecoder().decode(data) });
  }
}

let fetched: string[] = [];
let missing = new Set<string>();

beforeEach(() => {
  vi.resetModules();
  fetched = [];
  missing = new Set();
  FakeContext.last = null;
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('fetch', (url: string) => {
    fetched.push(url);
    const ok = !missing.has(url);
    return Promise.resolve({ ok, status: ok ? 200 : 404, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(url).buffer) });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const audio = () => import('..');

describe('the first touch wakes the sound (P58C T4)', () => {
  // Prst je gesto prohlížeče až při zvednutí (HTML „activation-triggering input event“: `pointerup`, `touchend`);
  // `pointerdown` prstu gesto nedává, takže iPhone by zvuk z něj nepustil.
  it.each(['pointerup', 'touchend'])('%s on the page starts the audio context', async (type) => {
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    const { installSoundControls } = await audio();
    const remove = installSoundControls();
    page.dispatchEvent(new Event(type));
    expect(FakeContext.last?.state).toBe('running');
    remove();
  });
});

describe('the game’s own sounds', () => {
  it('nothing is fetched before the first gesture', async () => {
    const { playMusic, setSoundLook } = await audio();
    setSoundLook('beach');
    playMusic('/music/beach-calm.ogg');
    await settle();
    expect(fetched).toEqual([]);
  });

  it('after the gesture the look’s five sounds load and a decoded one replaces ZzFX', async () => {
    const { playSfx, setSoundLook, unlockAudio } = await audio();
    setSoundLook('beach');
    unlockAudio();
    await settle();
    expect(fetched.filter((url) => url.includes('/audio/sfx/beach-'))).toHaveLength(5);
    const context = FakeContext.last!;
    playSfx('jump');
    expect(context.created).toBe(0);
    expect(context.sources.at(-1)!.buffer).toEqual({ decoded: '/assets/worldstream/audio/sfx/beach-jump.ogg' });
  });

  it('a sound file that fails to load falls back to ZzFX', async () => {
    missing.add('/assets/worldstream/audio/sfx/beach-hit.ogg');
    const { playSfx, setSoundLook, unlockAudio } = await audio();
    setSoundLook('beach');
    unlockAudio();
    await settle();
    const context = FakeContext.last!;
    playSfx('hit');
    expect(context.created).toBe(1);
    expect(context.sources.at(-1)!.buffer).toMatchObject({ zzfx: true });
  });

  it('without a look the game keeps its ZzFX sounds', async () => {
    const { playSfx, unlockAudio } = await audio();
    unlockAudio();
    await settle();
    playSfx('win');
    expect(fetched).toEqual([]);
    expect(FakeContext.last!.created).toBe(1);
  });

  it('a muted game plays no sound file', async () => {
    const { playSfx, setMuted, setSoundLook, unlockAudio } = await audio();
    setSoundLook('beach');
    unlockAudio();
    await settle();
    setMuted(true);
    playSfx('jump');
    expect(FakeContext.last!.sources).toEqual([]);
    setMuted(false);
  });
});

describe('the game’s own music', () => {
  it('the loop waits for the gesture, then loops; mute zeroes it, stop ends it', async () => {
    const { playMusic, setMuted, unlockAudio } = await audio();
    const stop = playMusic('/music/beach-calm.ogg');
    unlockAudio();
    await settle();
    const context = FakeContext.last!;
    const loop = context.sources.find((source) => source.loop)!;
    expect(loop.started).toBe(1);
    expect(loop.buffer).toEqual({ decoded: '/music/beach-calm.ogg' });
    expect(context.gains[0]!.gain.value).toBeGreaterThan(0);
    setMuted(true);
    expect(context.gains[0]!.gain.value).toBe(0);
    setMuted(false);
    expect(context.gains[0]!.gain.value).toBeGreaterThan(0);
    stop();
    expect(loop.stopped).toBe(1);
  });

  it('the next game’s loop replaces the old one; the old game’s stop leaves it playing', async () => {
    const { playMusic, unlockAudio } = await audio();
    unlockAudio();
    const stopOld = playMusic('/music/a.ogg');
    await settle();
    playMusic('/music/b.ogg');
    await settle();
    const context = FakeContext.last!;
    const [a, b] = context.sources.filter((source) => source.loop);
    expect(a!.stopped).toBe(1);
    stopOld();
    expect(b!.stopped).toBe(0);
  });

  it('a loop that fails to load stays silent', async () => {
    missing.add('/music/gone.ogg');
    const { playMusic, unlockAudio } = await audio();
    unlockAudio();
    playMusic('/music/gone.ogg');
    await settle();
    expect(FakeContext.last!.sources.filter((source) => source.loop)).toEqual([]);
  });

  it('PLAY_MUSIC=off keeps the music off', async () => {
    vi.stubEnv('PLAY_MUSIC', 'off');
    const { playMusic, unlockAudio } = await audio();
    unlockAudio();
    playMusic('/music/beach-calm.ogg');
    await settle();
    expect(fetched).toEqual([]);
  });
});

describe('music that follows the game (P37B T5)', () => {
  it('tension crossfades to the tense loop and back; the tense file is fetched ahead', async () => {
    const { playMusic, setMusicTension, unlockAudio } = await audio();
    unlockAudio();
    playMusic('/music/snow-calm.ogg', '/music/snow-tense.ogg');
    await settle();
    await settle();
    expect(fetched).toContain('/music/snow-tense.ogg');
    const context = FakeContext.last!;
    const loops = () => context.sources.filter((source) => source.loop);
    setMusicTension(true);
    await settle();
    expect(loops()).toHaveLength(2);
    expect(loops()[0]!.stopped).toBe(1);
    expect(loops()[1]!.buffer).toEqual({ decoded: '/music/snow-tense.ogg' });
    // Stará smyčka se stáhne k nule, nová nabíhá na hlasitost hudby.
    expect(context.gains[0]!.gain.value).toBe(0);
    expect(context.gains[1]!.gain.value).toBeGreaterThan(0);
    setMusicTension(false);
    await settle();
    expect(loops()).toHaveLength(3);
    expect(loops()[2]!.buffer).toEqual({ decoded: '/music/snow-calm.ogg' });
  });

  it('tension without a tense loop keeps the base loop playing', async () => {
    const { playMusic, setMusicTension, unlockAudio } = await audio();
    unlockAudio();
    playMusic('/music/cave-calm.ogg');
    await settle();
    setMusicTension(true);
    await settle();
    const loops = FakeContext.last!.sources.filter((source) => source.loop);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.stopped).toBe(0);
  });

  it.each(['win', 'lose'] as const)('a %s ducks the music under its sound, then brings it back', async (preset) => {
    const { MUSIC_DUCK, playMusic, playSfx, unlockAudio } = await audio();
    unlockAudio();
    playMusic('/music/beach-calm.ogg');
    await settle();
    const gain = FakeContext.last!.gains[0]!.gain;
    const full = gain.value;
    const ramps = gain.ramps.length;
    playSfx('pickup');
    expect(gain.ramps).toHaveLength(ramps);
    playSfx(preset);
    expect(gain.ramps.slice(-2)).toEqual([full * MUSIC_DUCK, full]);
  });

  it('the same sound twice in one tick plays once, the next tick plays again', async () => {
    vi.useFakeTimers();
    try {
      const { SFX_REPEAT_MS, playSfx, unlockAudio } = await audio();
      unlockAudio();
      await vi.runAllTimersAsync();
      const context = FakeContext.last!;
      const played = () => context.sources.filter((source) => !source.loop && source.started > 0).length;
      playSfx('pickup');
      playSfx('pickup');
      playSfx('chime');
      expect(played()).toBe(2);
      vi.advanceTimersByTime(SFX_REPEAT_MS);
      playSfx('pickup');
      expect(played()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
