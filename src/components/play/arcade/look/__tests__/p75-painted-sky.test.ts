/**
 * Malovaná obloha (P75 T3). Pinuje, co by na snímku vypadalo dobře, a přesto bylo
 * špatně: obraz stažený před prvním snímkem (zdrží start hry), prolnutí skokem,
 * chyba sítě, po které se obloha ztratí nebo se stahuje dokola, a obraz nad limit.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, PAINTED_SKIES, sceneLook } from '@/play/arcade/look';
import { restyleLook, TODAY_STYLE } from '@/play/arcade/look/style';

import { FEED_CARD, PAINT_FADE_S, type PaintLoad, paintedSkyOf, paintFade, stagePlace } from '../rig/painted-sky';

const FRAME = 1 / 60;

/** Stahování, které se dokončí, až test řekne. */
function pending() {
  const calls: { url: string; ready: () => void; failed: () => void }[] = [];
  const load: PaintLoad = (url, ready, failed) => void calls.push({ url, ready, failed });
  return { calls, load };
}

describe('paintFade', () => {
  it('draws the first frame with today’s sky and starts loading only after it', () => {
    const { calls, load } = pending();
    const step = paintFade('/play/env/diorama-volcano.webp', load);
    expect(step(FRAME)).toEqual({ amount: 0, busy: true });
    expect(calls).toHaveLength(0);
    expect(step(FRAME).amount).toBe(0);
    expect(calls.map((call) => call.url)).toEqual(['/play/env/diorama-volcano.webp']);
  });

  it('fades the painting in within one second, not in one jump', () => {
    const { calls, load } = pending();
    const step = paintFade('/x.webp', load);
    step(FRAME);
    step(FRAME);
    calls[0]!.ready();
    // Po nečinném plátně přijde jeden dlouhý snímek: obraz nesmí naskočit celý.
    expect(step(5).amount).toBeLessThan(0.1);
    let seconds = 0;
    let last = 0;
    for (let amount = 0; amount < 1; seconds += FRAME) {
      ({ amount } = step(FRAME));
      expect(amount).toBeGreaterThanOrEqual(last);
      last = amount;
    }
    expect(seconds).toBeLessThanOrEqual(1);
    expect(seconds).toBeGreaterThan(PAINT_FADE_S / 2);
    expect(step(FRAME)).toEqual({ amount: 1, busy: false });
  });

  it('keeps today’s sky after a failed load and never retries', () => {
    const { calls, load } = pending();
    const step = paintFade('/x.webp', load);
    step(FRAME);
    step(FRAME);
    calls[0]!.failed();
    for (let i = 0; i < 300; i += 1) expect(step(FRAME)).toEqual({ amount: 0, busy: false });
    expect(calls).toHaveLength(1);
  });

  it('loads nothing for a place without a painting', () => {
    const { calls, load } = pending();
    const step = paintFade(null, load);
    for (let i = 0; i < 10; i += 1) expect(step(FRAME)).toEqual({ amount: 0, busy: false });
    expect(calls).toHaveLength(0);
  });
});

describe('painted skies on disk', () => {
  const root = join(__dirname, '..', '..', '..', '..', '..', '..');
  const disclosure = JSON.parse(readFileSync(join(root, 'disclosure.json'), 'utf8')) as { entries: { name: string; license?: string }[] };
  const listed = new Map(disclosure.entries.map((entry) => [entry.name, entry.license]));

  it.each(Object.keys(PAINTED_SKIES))('%s: full ≤ 300 kB, phone copy, licence entry', (place) => {
    for (const [suffix, limit] of [
      ['', 300_000],
      ['-low', 60_000],
    ] as const) {
      const name = `public/play/env/diorama-${place}${suffix}.webp`;
      expect(existsSync(join(root, name)), name).toBe(true);
      expect(statSync(join(root, name)).size).toBeLessThanOrEqual(limit);
      expect(listed.get(name)).toBe('LicenseRef-Worldsmith-Generated');
    }
  });

  it('paints every outdoor place and no hall', () => {
    const outdoor = LOOK_IDS.filter((id) => LOOKS[id].ceiling === undefined && LOOKS[id].interior === undefined);
    expect(outdoor.filter((id) => PAINTED_SKIES[id] === undefined)).toEqual([]);
    expect(LOOK_IDS.filter((id) => LOOKS[id].ceiling !== undefined && PAINTED_SKIES[id] !== undefined)).toEqual([]);
  });

  it('gives the phone the small copy and darkens the painting at night, not by day', () => {
    const day = sceneLook({ setting: 'a volcano', mood: '', look: 'volcano' });
    expect(paintedSkyOf(day, 'volcano', 'high')?.url).toBe('/play/env/diorama-volcano.webp');
    expect(paintedSkyOf(day, 'volcano', 'low')?.url).toBe('/play/env/diorama-volcano-low.webp');
    const tint = paintedSkyOf(day, 'volcano', 'high')!.tint;
    expect([tint.r, tint.g, tint.b]).toEqual([1, 1, 1]);
    const night = paintedSkyOf(sceneLook({ setting: 'a meadow at night', mood: '', look: 'meadow' }), 'meadow', 'high')!.tint;
    expect(Math.max(night.r, night.g, night.b)).toBeLessThan(0.8);
    expect(paintedSkyOf(sceneLook({ setting: 'a mall', mood: '', look: 'mall' }), 'mall', 'high')).toBeNull();
  });

  // T7b: na `/play` telefonu obraz zdržel vstup do hry; desktop feed a hra ho mají dál.
  it('keeps the phone feed preview on the plain sky, not the game or the desktop feed', () => {
    const day = sceneLook({ setting: 'a meadow', mood: '', look: 'meadow' });
    expect(paintedSkyOf(day, 'meadow', 'low', 'feed')).toBeNull();
    expect(paintedSkyOf(day, 'meadow', 'medium', 'feed')).toBeNull();
    expect(paintedSkyOf(day, 'meadow', 'high', 'feed')?.url).toBe('/play/env/diorama-meadow.webp');
    expect(paintedSkyOf(day, 'meadow', 'low', 'game')?.url).toBe('/play/env/diorama-meadow-low.webp');
    expect(paintedSkyOf(day, 'meadow', 'medium')?.url).toBe('/play/env/diorama-meadow-low.webp');
    expect(stagePlace(null)).toBe('game');
    // Selektor karty musí sedět na kartu feedu, jinak náhled tiše dostane obraz zpátky.
    const card = readFileSync(join(root, 'src/components/play/feed/ReelCard.tsx'), 'utf8');
    expect(card).toMatch(/<article[^>]*data-testid="feed-card"/);
    expect(FEED_CARD).toBe('[data-testid="feed-card"]');
  });
});

// P76 T2: soudce proti `main` – hnědá zem a barevné domy malované oblohy „less convincing as a stormy city“.
describe('P76 T2: bouřlivé město studeně', () => {
  const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  const lum = (hex: string) => rgb(hex).reduce((sum, channel) => sum + channel, 0);

  it('gives the stormy city a cold wet ground and the overcast mood sky instead of the sunny painting', () => {
    for (const stormy of [sceneLook({ setting: 'a stormy city', mood: '', look: 'city' }), sceneLook({ setting: 'a city', mood: '', look: 'city', weather: 'rain' })]) {
      const [r, , b] = rgb(stormy.ground);
      expect(b, stormy.ground).toBeGreaterThan(r);
      expect(lum(stormy.ground)).toBeLessThan(lum(LOOKS.city.ground));
      expect(paintedSkyOf(stormy, 'city', 'high')).toBeNull();
      expect(paintedSkyOf(stormy, 'city', 'low')).toBeNull();
    }
  });

  it('leaves the clear city and every place without a storm its P75 ground and painting', () => {
    const clear = sceneLook({ setting: 'a city', mood: '', look: 'city' });
    // Zem jasného města = zem sady pod profilem vzhledu (P81 ji přebarví u všech míst stejně), bez mokré bouřky.
    expect(clear.ground).toBe(restyleLook(LOOKS.city, 'city', { night: false, overcast: false }).ground);
    expect(paintedSkyOf(clear, 'city', 'high')?.url).toBe('/play/env/diorama-city.webp');
    for (const id of Object.keys(PAINTED_SKIES) as (keyof typeof PAINTED_SKIES)[]) {
      const day = sceneLook({ setting: `a ${id}`, mood: '', look: id });
      expect(day.storm, id).toBeUndefined();
      const stormy = sceneLook({ setting: `a ${id}`, mood: '', look: id, weather: 'rain' });
      // Proti suché zemi místa bez profilu P81: profil zem jasné oblohy přebarví (jas drží, součet kanálů ne).
      const dry = sceneLook({ setting: `a ${id}`, mood: '', look: id }, TODAY_STYLE);
      const [[r0, , b0], [r1, , b1]] = [rgb(dry.ground), rgb(stormy.ground)];
      // Déšť zem ztmaví (už tmavší než mokrá šedomodrá jen ochladí) a teplou ochladí aspoň o polovinu všude,
      // nejen ve městě; studená se teplou nestane.
      expect(r1 - b1, id).toBeLessThanOrEqual(Math.max(0, (r0 - b0) / 2));
      expect(lum(stormy.ground), id).toBeLessThanOrEqual(Math.max(lum(dry.ground), lum('#2c3e50')));
    }
  });
});
