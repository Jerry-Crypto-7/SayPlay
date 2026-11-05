/**
 * P71B T4: karta, která nehraje, přehrává klip – jen v dosahu (zorné pole ±1 soused), mimo něj pustí dekodér;
 * offline klip jen hrám ze sady; aktivní karta video nemá (hraje živě).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { type ClipTurns, type ClipVideo, clipInSight, createClipTurns, joinClipTurns, offlineClip } from '../CardClip';
import offline from '../feed-clips.json';
import { ReelCard } from '../ReelCard';
import { createStageTunnel } from '../stage-tunnel';

function fakeVideo() {
  const attributes = new Map<string, string>();
  const video = {
    get src() {
      return attributes.get('src') ?? '';
    },
    set src(value: string) {
      attributes.set('src', value);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => void attributes.delete(name),
    pause: vi.fn(),
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
  };
  return video as typeof video & ClipVideo;
}

describe('clipInSight', () => {
  it('a card in reach gets its clip and plays; out of reach it pauses and lets the decoder go', () => {
    const video = fakeVideo();
    clipInSight(video, '/play/feed-clips/a.mp4', true);
    expect(video.getAttribute('src')).toBe('/play/feed-clips/a.mp4');
    expect(video.play).toHaveBeenCalledTimes(1);

    clipInSight(video, '/play/feed-clips/a.mp4', false);
    expect(video.pause).toHaveBeenCalled();
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.load).toHaveBeenCalledTimes(1);

    // Znovu v dosahu: src zpět a hraje.
    clipInSight(video, '/play/feed-clips/a.mp4', true);
    expect(video.getAttribute('src')).toBe('/play/feed-clips/a.mp4');
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('a video that never loaded is not reloaded when it leaves, and a refused autoplay does not throw', async () => {
    const video = fakeVideo();
    clipInSight(video, '/x.mp4', false);
    expect(video.load).not.toHaveBeenCalled();
    video.play.mockImplementationOnce(() => Promise.reject(new DOMException('no autoplay', 'NotAllowedError')));
    expect(() => clipInSight(video, '/x.mp4', true)).not.toThrow();
    await Promise.resolve();
  });
});

describe('clip turns (P71B T5: two visible playing clips cost the live card 30 FPS)', () => {
  const playing = (video: ReturnType<typeof fakeVideo>) => {
    const plays = video.play.mock.invocationCallOrder.at(-1) ?? 0;
    const pauses = video.pause.mock.invocationCallOrder.at(-1) ?? 0;
    return plays > pauses;
  };
  const visibleClip = (turns: ClipTurns, src: string) => {
    const video = fakeVideo();
    const clip = joinClipTurns(video, src, turns);
    clip.reach(true);
    clip.view(true);
    return { video, clip };
  };

  it('of two visible clips only one plays, the other stands with its clip loaded', () => {
    const turns = createClipTurns();
    const a = visibleClip(turns, '/a.mp4');
    const b = visibleClip(turns, '/b.mp4');
    expect(playing(a.video)).toBe(true);
    expect(playing(b.video)).toBe(false);
    expect(b.video.getAttribute('src')).toBe('/b.mp4');
  });

  it('the end of a loop passes the turn to the next visible clip and round again; a lone clip replays', () => {
    const turns = createClipTurns();
    const a = visibleClip(turns, '/a.mp4');
    const b = visibleClip(turns, '/b.mp4');
    a.clip.ended();
    expect([playing(a.video), playing(b.video)]).toEqual([false, true]);
    // Konec smyčky klipu, který není na tahu, tah nebere.
    a.clip.ended();
    expect([playing(a.video), playing(b.video)]).toEqual([false, true]);
    b.clip.ended();
    expect([playing(a.video), playing(b.video)]).toEqual([true, false]);

    const lone = visibleClip(createClipTurns(), '/c.mp4');
    const before = lone.video.play.mock.calls.length;
    lone.clip.ended();
    expect(lone.video.play.mock.calls.length).toBeGreaterThan(before);
    expect(playing(lone.video)).toBe(true);
  });

  it('a clip leaving the view passes the turn on and loops freely while still in reach', () => {
    const turns = createClipTurns();
    const a = visibleClip(turns, '/a.mp4');
    const b = visibleClip(turns, '/b.mp4');
    a.clip.view(false);
    expect([playing(a.video), playing(b.video)]).toEqual([true, true]);
    // Mimo obraz hraje dokola, tah nechá být.
    a.clip.ended();
    expect([playing(a.video), playing(b.video)]).toEqual([true, true]);
    // Unmount klipu na tahu předá tah dál.
    const c = visibleClip(turns, '/c.mp4');
    expect(playing(c.video)).toBe(false);
    b.clip.leave();
    expect(b.video.hasAttribute('src')).toBe(false);
    expect(playing(c.video)).toBe(true);
  });
});

describe('offlineClip', () => {
  it('only games in feed-clips.json have an offline clip', () => {
    expect(offline.length).toBeGreaterThan(0);
    expect(offlineClip(offline[0])).toBe(`/play/feed-clips/${offline[0]}.mp4`);
    expect(offlineClip('not-in-the-set')).toBeUndefined();
  });
});

describe('ReelCard with a clip', () => {
  const game = { versionId: offline[0], title: 'Clip game', archetype: 'collect', remixes: 0 };
  const card = (active: boolean, clip: string | undefined) =>
    renderToStaticMarkup(<ReelCard game={game} index={1} active={active} detail={undefined} live host={createStageTunnel(null)} preview={undefined} shot={undefined} clip={clip} />);

  it('an inactive card plays the clip over its poster: muted, inline, looped by its turn, nothing loaded up front', () => {
    const html = card(false, '/play/feed-clips/a.mp4');
    // Atributy HTML nerozlišují velikost písmen (React píše `playsInline`).
    const video = (/<video[^>]*>/.exec(html)?.[0] ?? '').toLowerCase();
    expect(video).toContain('data-testid="card-clip"');
    expect(video).toMatch(/\smuted[\s=>]/);
    expect(video).toMatch(/\splaysinline[\s=>]/);
    // Smyčku dělá `ended` (tah mezi viditelnými klipy), `loop` by konec klipu nikdy neohlásil.
    expect(video).not.toMatch(/\sloop[\s=>]/);
    expect(video).toContain('preload="none"');
    expect(video).toMatch(/poster="[^"]+"/);
    // `src` dostane až video v dosahu (`clipInSight`).
    expect(video).not.toMatch(/\ssrc=/);
  });

  it('without a clip the card stays a picture, and the active card has no video', () => {
    expect(card(false, undefined)).not.toContain('<video');
    expect(card(true, '/play/feed-clips/a.mp4')).not.toContain('card-clip');
  });
});
