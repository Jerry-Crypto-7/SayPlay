/**
 * Náhled z workeru (P71B T1): selhání workeru – chyba výpočtu i pád workeru – vrátí `null` a zaloguje id hry,
 * ale nezapamatuje se, takže další návštěva karty zkusí worker znovu. Hotový náhled se počítá jen jednou.
 *
 * Testy běží bez prohlížeče: `Worker` nahrazuje třída, která odpoví podle fronty připravených odpovědí.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { FeedPreview } from '@/play/version/version';

import type { BotWorkerRequest, BotWorkerResponse } from '../bot-worker';
import { previewFor } from '../preview';

const PREVIEW: FeedPreview = { startTick: 10, endTick: 250, inputs: '10~0b1', hash: 'h' };
const WORLD = {} as ArcadeWorld;

type Answer = 'preview' | 'error' | 'crash';

let answers: Answer[] = [];
let posted: string[] = [];

class FakeWorker {
  onmessage: ((event: { data: BotWorkerResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(request: BotWorkerRequest): void {
    posted.push(request.versionId);
    const answer = answers.shift() ?? 'preview';
    queueMicrotask(() => {
      if (answer === 'crash') this.onerror?.();
      else this.onmessage?.({ data: answer === 'error' ? { versionId: request.versionId, error: 'bot stuck' } : { versionId: request.versionId, preview: PREVIEW } });
    });
  }
}

beforeEach(() => {
  answers = [];
  posted = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('previewFor (P71B T1)', () => {
  it('a failed computation is logged with the game id and the next visit computes again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    answers = ['error', 'preview'];
    expect(await previewFor('g-error', undefined, WORLD)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('g-error'));
    expect(await previewFor('g-error', undefined, WORLD)).toEqual(PREVIEW);
    expect(posted).toEqual(['g-error', 'g-error']);
  });

  it('a crashed worker fails the waiting game without remembering it, and a fresh worker computes it next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    answers = ['crash', 'preview'];
    expect(await previewFor('g-crash', undefined, WORLD)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('g-crash'));
    expect(await previewFor('g-crash', undefined, WORLD)).toEqual(PREVIEW);
    expect(posted).toEqual(['g-crash', 'g-crash']);
  });

  it('a computed preview is kept: the worker runs once per game', async () => {
    const first = await previewFor('g-once', undefined, WORLD);
    expect(first).toEqual(PREVIEW);
    expect(await previewFor('g-once', undefined, WORLD)).toBe(first);
    expect(posted).toEqual(['g-once']);
  });

  it('a stored preview from publishing never reaches the worker', async () => {
    expect(await previewFor('g-stored', PREVIEW, WORLD)).toBe(PREVIEW);
    expect(posted).toEqual([]);
  });
});
