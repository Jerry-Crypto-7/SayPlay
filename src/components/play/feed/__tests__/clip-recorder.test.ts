/**
 * Klip aktivní karty (P71B T2): formát podle toho, co prohlížeč umí, klip `CLIP_MS` z plátna, strop velikosti
 * a zrušení, když náhled přestane běžet (hráč hru převzal, karta odjela, stránka na pozadí). Bez prohlížeče:
 * `MediaRecorder` a plátno nahrazují malé náhrady, čas hodiny vitestu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIP_FPS, CLIP_MAX_BYTES, CLIP_MS, clipsAllowed, clipType, frameMeter, markClipsSlow, recordClip, type Recorder, SLOW_KEY, SMOOTH_FPS, SMOOTH_WINDOW_MS } from '../clip-recorder';

const MP4 = 'video/mp4;codecs=avc1.42E01E';
const VP9 = 'video/webm;codecs=vp9';

interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

/** Plátno, které vrací proud s jednou stopou; pamatuje si požadované snímky za sekundu. */
function fakeCanvas() {
  const track: FakeTrack = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const fps: number[] = [];
  const canvas = {
    captureStream: (rate?: number) => {
      fps.push(rate ?? 0);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
  };
  return { canvas, track, fps };
}

/** `MediaRecorder` jako zápisník: po `stop()` vydá data o velikosti `chunkBytes` a pak `onstop`. */
function fakeRecorder(supported: readonly string[], chunkBytes = 500_000) {
  const made: { options: MediaRecorderOptions | undefined; started: boolean }[] = [];
  class Fake {
    static isTypeSupported = (type: string) => supported.includes(type);
    state: RecordingState = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly record: (typeof made)[number];
    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      this.mimeType = options?.mimeType ?? '';
      this.record = { options, started: false };
      made.push(this.record);
    }
    start() {
      this.state = 'recording';
      this.record.started = true;
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(chunkBytes)]) });
        this.onstop?.();
      });
    }
  }
  return { Recorder: Fake as unknown as Recorder, made };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clipType', () => {
  it('prefers MP4/H.264, then WebM/VP9, then plain WebM; nothing usable is null', () => {
    expect(clipType({ isTypeSupported: (type) => [MP4, VP9, 'video/webm'].includes(type) })).toBe(MP4);
    expect(clipType({ isTypeSupported: (type) => [VP9, 'video/webm'].includes(type) })).toBe(VP9);
    expect(clipType({ isTypeSupported: (type) => type === 'video/webm' })).toBe('video/webm');
    expect(clipType({ isTypeSupported: () => false })).toBeNull();
  });
});

describe('clipsAllowed', () => {
  const env = (over: { recorder?: Recorder | undefined; reduce?: boolean; visibility?: DocumentVisibilityState } = {}) => ({
    MediaRecorder: 'recorder' in over ? over.recorder : fakeRecorder([VP9]).Recorder,
    matchMedia: () => ({ matches: over.reduce ?? false }),
    document: { visibilityState: over.visibility ?? 'visible' },
  });

  it('records only with a recorder that knows a format, without reduced motion and on a visible page', () => {
    expect(clipsAllowed(env())).toBe(true);
    expect(clipsAllowed(env({ recorder: undefined }))).toBe(false);
    expect(clipsAllowed(env({ recorder: fakeRecorder([]).Recorder }))).toBe(false);
    expect(clipsAllowed(env({ reduce: true }))).toBe(false);
    expect(clipsAllowed(env({ visibility: 'hidden' }))).toBe(false);
  });

  it('a device where recording broke the frame rate never records again; blocked storage does not stop clips', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(clipsAllowed({ ...env(), localStorage: storage })).toBe(true);
    markClipsSlow(storage);
    expect(store.get(SLOW_KEY)).toBe('1');
    expect(clipsAllowed({ ...env(), localStorage: storage })).toBe(false);
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(() => markClipsSlow(blocked)).not.toThrow();
    expect(clipsAllowed({ ...env(), localStorage: blocked })).toBe(true);
  });
});

describe('frameMeter', () => {
  /** Ruční `requestAnimationFrame`: `frame(t)` pustí čekající tik s časem `t`. */
  const manualRaf = () => {
    let pending: FrameRequestCallback | null = null;
    let cancelled = false;
    return {
      raf: (tick: FrameRequestCallback) => {
        pending = tick;
        return 1;
      },
      cancel: () => void (cancelled = true),
      frame: (at: number) => {
        const tick = pending;
        pending = null;
        if (!cancelled) tick?.(at);
      },
    };
  };
  const run = (meter: ReturnType<typeof manualRaf>, from: number, to: number, step: number) => {
    for (let at = from; at <= to; at += step) meter.frame(at);
  };

  it('is smooth at 60 fps once half a window has run, not before', () => {
    const clock = manualRaf();
    const meter = frameMeter(clock.raf, clock.cancel);
    expect(meter.smooth(0)).toBe(false);
    run(clock, 0, 200, 1000 / 60);
    expect(meter.smooth(200)).toBe(false);
    run(clock, 1000 / 60 + 200, 1000, 1000 / 60);
    expect(meter.smooth(1000)).toBe(true);
  });

  it('is not smooth below SMOOTH_FPS, and one long hitch among good frames is tolerated', () => {
    const clock = manualRaf();
    const meter = frameMeter(clock.raf, clock.cancel);
    run(clock, 0, 1000, 1000 / 45);
    expect(meter.smooth(1000)).toBe(false);
    const other = manualRaf();
    const hitched = frameMeter(other.raf, other.cancel);
    run(other, 0, 800, 1000 / 60);
    run(other, 1000, 1200, 1000 / 60);
    expect(hitched.smooth(1200)).toBe(true);
    expect(1000 / SMOOTH_FPS).toBeLessThan(1000 / 45);
  });

  it('a page that stopped producing frames for half a window is not smooth', () => {
    const clock = manualRaf();
    const meter = frameMeter(clock.raf, clock.cancel);
    run(clock, 0, 1000, 1000 / 60);
    expect(meter.smooth(1000)).toBe(true);
    expect(meter.smooth(1000 + SMOOTH_WINDOW_MS / 2 - 50)).toBe(true);
    expect(meter.smooth(1000 + SMOOTH_WINDOW_MS / 2 + 20)).toBe(false);
  });

  it('stop cancels the frame loop', () => {
    const clock = manualRaf();
    const meter = frameMeter(clock.raf, clock.cancel);
    meter.stop();
    run(clock, 0, 1000, 1000 / 60);
    expect(meter.smooth(1000)).toBe(false);
  });
});

describe('recordClip', () => {
  it('records CLIP_MS at CLIP_FPS in the best format and stops the canvas stream', async () => {
    const { canvas, track, fps } = fakeCanvas();
    const { Recorder, made } = fakeRecorder([MP4, VP9]);
    const job = recordClip(canvas, () => true, Recorder);
    expect(made).toHaveLength(1);
    expect(made[0]!.started).toBe(true);
    expect(made[0]!.options?.mimeType).toBe(MP4);
    expect(fps).toEqual([CLIP_FPS]);
    await vi.advanceTimersByTimeAsync(CLIP_MS - 1);
    expect(track.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const clip = await job.done;
    expect(clip?.size).toBe(500_000);
    // Blob typ normalizuje na malá písmena.
    expect(clip?.type).toBe(MP4.toLowerCase());
    expect(track.stopped).toBe(true);
  });

  it('a clip over the size cap is dropped', async () => {
    const { canvas } = fakeCanvas();
    const job = recordClip(canvas, () => true, fakeRecorder([VP9], CLIP_MAX_BYTES + 1).Recorder);
    await vi.advanceTimersByTimeAsync(CLIP_MS);
    expect(await job.done).toBeNull();
  });

  it('stops early and drops the clip once the preview stops (the player took the game)', async () => {
    const { canvas, track } = fakeCanvas();
    let previewing = true;
    const job = recordClip(canvas, () => previewing, fakeRecorder([VP9]).Recorder);
    await vi.advanceTimersByTimeAsync(CLIP_MS / 2);
    previewing = false;
    await vi.advanceTimersByTimeAsync(CLIP_MS / 4);
    expect(track.stopped).toBe(true);
    expect(await job.done).toBeNull();
  });

  it('cancel drops the clip (the card left the canvas)', async () => {
    const { canvas, track } = fakeCanvas();
    const job = recordClip(canvas, () => true, fakeRecorder([VP9]).Recorder);
    await vi.advanceTimersByTimeAsync(CLIP_MS / 3);
    job.cancel();
    expect(await job.done).toBeNull();
    expect(track.stopped).toBe(true);
  });

  it('a browser without a usable format never touches the canvas', async () => {
    const { canvas, fps } = fakeCanvas();
    expect(await recordClip(canvas, () => true, fakeRecorder([]).Recorder).done).toBeNull();
    expect(fps).toEqual([]);
  });
});
