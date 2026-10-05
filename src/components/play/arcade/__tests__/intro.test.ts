/**
 * Úvodní průlet kamery (P37B T6). Že průlet trvá 1,5 s místo 0,9 s, nebo že
 * kamera při dosednutí přeletí hrdinu o třetinu záběru, z jednoho snímku
 * nepoznáš – a zdržený první pohled na hrdinu je přesně „janky“ start, který
 * game jamy trestají. Pin hlídá délku, dosednutí a že první vstup průlet ukončí.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ effects: [] as (() => unknown)[] }));

// Háček se volá jako funkce: ref je obyčejný objekt, efekt si test pustí sám.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
}));

const { INTRO_S, applyIntro, introLeft, useIntroClock } = await import('../look/intro');

afterEach(() => {
  hooks.effects.length = 0;
  vi.unstubAllGlobals();
});

describe('camera intro', () => {
  it('lasts 0.6–1.0 s and ends exactly on the game view', () => {
    expect(INTRO_S).toBeGreaterThanOrEqual(0.6);
    expect(INTRO_S).toBeLessThanOrEqual(1);
    expect(introLeft(0)).toBe(1);
    expect(introLeft(INTRO_S)).toBe(0);
    expect(introLeft(INTRO_S + 5)).toBe(0);
  });

  it('lands: a short, gentle dip past the game view in the last part, then settles', () => {
    const samples = Array.from({ length: 91 }, (_, i) => introLeft((i / 90) * INTRO_S));
    const dip = Math.min(...samples);
    expect(dip).toBeLessThan(0);
    expect(dip).toBeGreaterThan(-0.06);
    expect(samples.indexOf(dip) / 90).toBeGreaterThan(0.5);
    // Do poloviny průletu ujede kamera víc než tři čtvrtiny dráhy – hrdina je brzy zblízka.
    expect(introLeft(INTRO_S / 2)).toBeLessThan(0.25);
  });

  it('leaves the game view alone once the intro is over, and pulls back and up at its start', () => {
    const look = new Vector3(1, 0, 2);
    const camera = new PerspectiveCamera();
    camera.position.set(1, 5, -6);
    applyIntro(camera, look, 0);
    expect(camera.position.toArray()).toEqual([1, 5, -6]);
    applyIntro(camera, look, 1);
    expect(camera.position.distanceTo(look)).toBeGreaterThan(new Vector3(1, 5, -6).distanceTo(look) * 2);
    expect(camera.position.y).toBeGreaterThan(5);
  });

  it('the first key or tap ends the intro at once', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    vi.stubGlobal('performance', { now: () => 0 });
    const clock = useIntroClock();
    for (const effect of hooks.effects) effect();
    expect(introLeft(clock())).toBe(1);
    win.dispatchEvent(new Event('pointerdown'));
    expect(introLeft(clock())).toBe(0);
  });
});
