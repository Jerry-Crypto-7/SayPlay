/**
 * P71B T4: karta, která nehraje, přehrává klip – jen v dosahu (zorné pole ±1 soused), mimo něj pustí dekodér;
 * offline klip jen hrám ze sady; aktivní karta video nemá (hraje živě).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { type ClipVideo, clipInSight, offlineClip } from '../CardClip';
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

  it('an inactive card plays the clip over its poster: muted, inline, looping, nothing loaded up front', () => {
    const html = card(false, '/play/feed-clips/a.mp4');
    // Atributy HTML nerozlišují velikost písmen (React píše `playsInline`).
    const video = (/<video[^>]*>/.exec(html)?.[0] ?? '').toLowerCase();
    expect(video).toContain('data-testid="card-clip"');
    expect(video).toMatch(/\smuted[\s=>]/);
    expect(video).toMatch(/\splaysinline[\s=>]/);
    expect(video).toMatch(/\sloop[\s=>]/);
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
