/**
 * Klip běhu (P29D T1): formát podle `MediaRecorder.isTypeSupported`, strop
 * délky včetně dojezdu po konci hry a úklid streamu plátna.
 *
 * Prázdný nebo useknutý klip vypadá jako klip – test proto drží, KTERÝ úsek
 * záznamu se vydá a že nikdy není delší než strop.
 */

import { describe, expect, it } from 'vitest';

import { CLIP_MAX_MS, CLIP_TAIL_MS, clipType, startClip, type ClipDeps, type ClipRecorderLike } from '../clip';

class FakeRecorder implements ClipRecorderLike {
  static all: FakeRecorder[] = [];
  /** Rekordér, který nic nenahrál (kodek selhal, plátno nekreslilo). */
  static empty = false;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  startedAt = -1;
  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string },
    private readonly clock: Clock,
  ) {
    FakeRecorder.all.push(this);
  }
  start(): void {
    this.state = 'recording';
    this.startedAt = this.clock.now;
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // Obsah „nahrávky“ nese dobu, od kdy běžela – test tak pozná, který úsek vyhrál.
    const bytes = FakeRecorder.empty ? [] : [`${this.startedAt}-${this.clock.now}`];
    this.ondataavailable?.({ data: new Blob(bytes, { type: this.options.mimeType }) });
    this.onstop?.();
  }
}

class Clock {
  now = 0;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private next = 1;
  set = (run: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.push({ at: this.now + ms, run, id });
    return id;
  };
  clear = (id: number): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (due === undefined || due.at > end) break;
      this.timers.shift();
      this.now = due.at;
      due.run();
    }
    this.now = end;
  }
}

function setup(supported: readonly string[] = ['video/webm']) {
  FakeRecorder.all = [];
  FakeRecorder.empty = false;
  const clock = new Clock();
  const stopped: string[] = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push('video') }] };
  const canvas = { captureStream: () => stream } as unknown as HTMLCanvasElement;
  const deps: ClipDeps = {
    Recorder: class extends FakeRecorder {
      constructor(s: unknown, o: { mimeType: string }) {
        super(s, o, clock);
      }
    },
    isTypeSupported: (type) => supported.includes(type),
    setTimeout: clock.set,
    clearTimeout: clock.clear,
  };
  return { clock, stopped, canvas, deps };
}

/** Úsek „od-do“ z obsahu blobu falešného rekordéru. */
async function span(blob: Blob | null): Promise<[number, number]> {
  expect(blob).not.toBeNull();
  const [from, to] = (await blob!.text()).split('-').map(Number);
  return [from!, to!];
}

describe('clip format', () => {
  it('prefers mp4 when the recorder supports it', () => {
    expect(clipType((type) => type === 'video/mp4' || type === 'video/webm')).toBe('video/mp4');
  });

  it('falls back to webm, and to nothing without either', () => {
    expect(clipType((type) => type === 'video/webm')).toBe('video/webm');
    expect(clipType(() => false)).toBeNull();
  });

  it('a canvas without captureStream records nothing', () => {
    const { deps } = setup();
    expect(startClip({} as HTMLCanvasElement, deps)).toBeNull();
  });

  it('records in the chosen type', async () => {
    const { clock, canvas, deps } = setup(['video/mp4', 'video/webm']);
    const clip = startClip(canvas, deps)!;
    clock.advance(3_000);
    const done = clip.finish();
    clock.advance(CLIP_TAIL_MS);
    const blob = await done;
    expect(blob?.type).toBe('video/mp4');
  });
});

describe('clip length', () => {
  it('a short run is recorded whole, with the tail after the end', async () => {
    const { clock, canvas, deps } = setup();
    const clip = startClip(canvas, deps)!;
    clock.advance(4_000);
    const done = clip.finish();
    clock.advance(CLIP_TAIL_MS);
    expect(await span(await done)).toEqual([0, 4_000 + CLIP_TAIL_MS]);
  });

  it('a long run keeps its ending and never exceeds the cap', async () => {
    for (const runMs of [20_000, 40_000, 61_234, 90_000]) {
      const { clock, canvas, deps } = setup();
      const clip = startClip(canvas, deps)!;
      clock.advance(runMs);
      const done = clip.finish();
      clock.advance(CLIP_TAIL_MS);
      const [from, to] = await span(await done);
      expect(to, `run ${runMs}`).toBe(runMs + CLIP_TAIL_MS);
      expect(to - from, `run ${runMs}`).toBeLessThanOrEqual(CLIP_MAX_MS);
      // Ne useknutý pahýl: aspoň polovina stropu, když běh byl delší.
      expect(to - from, `run ${runMs}`).toBeGreaterThanOrEqual(CLIP_MAX_MS / 2);
    }
  });
});

describe('empty recording', () => {
  it('a recorder that captured no bytes yields no clip', async () => {
    const { clock, canvas, deps } = setup();
    FakeRecorder.empty = true;
    const clip = startClip(canvas, deps)!;
    clock.advance(5_000);
    const done = clip.finish();
    clock.advance(CLIP_TAIL_MS);
    expect(await done).toBeNull();
  });
});

describe('clip cleanup', () => {
  it('finishing stops every recorder and the canvas stream', async () => {
    const { clock, stopped, canvas, deps } = setup();
    const clip = startClip(canvas, deps)!;
    clock.advance(30_000);
    const done = clip.finish();
    clock.advance(CLIP_TAIL_MS);
    await done;
    expect(FakeRecorder.all.every((recorder) => recorder.state === 'inactive')).toBe(true);
    expect(stopped).toEqual(['video']);
  });

  it('cancelling yields nothing and leaves no timer recording', () => {
    const { clock, stopped, canvas, deps } = setup();
    const clip = startClip(canvas, deps)!;
    clock.advance(10_000);
    clip.cancel();
    const count = FakeRecorder.all.length;
    clock.advance(60_000);
    expect(FakeRecorder.all.length).toBe(count);
    expect(FakeRecorder.all.every((recorder) => recorder.state === 'inactive')).toBe(true);
    expect(stopped).toEqual(['video']);
  });
});
