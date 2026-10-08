/**
 * Zvuk je zapojený tam, kde se děje (P37B T5). `bus-sound.test.ts` hlídá, co
 * má zaznít; tady se hlídá, že to někdo opravdu přehraje – nápřah hrdiny
 * z události jádra a každá událost sběrnice efektů. Odpojený zvuk na snímku
 * ani v klipu nepoznáš a jednotkové testy tabulek zůstanou zelené.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a `useFrame` nahrazuje malá
 * náhrada, komponenta se volá jako funkce a test pustí její efekty sám.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArcadeEffect } from '@/play/arcade/contract';

import { HeroActionBody } from '../hero-action/HeroActionBody';
import type { ArcadeEventListener } from '../session';

const hooks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  played: [] as string[],
  refs: [] as { current: unknown }[],
  frame: null as ((state: unknown, delta: number) => void) | null,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useRef: (current: unknown) => {
      const ref = { current };
      hooks.refs.push(ref);
      return ref;
    },
    useEffect: (effect: () => unknown) => hooks.effects.push(effect),
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: (frame: (state: unknown, delta: number) => void) => {
    hooks.frame = frame;
  },
}));
vi.mock('@/play/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/play/audio')>()),
  playHeroActionSfx: (action: string) => hooks.played.push(action),
}));

/** Hrdina s danou činností; vrátí posluchače událostí, kterého si připojil (nebo `null`). */
function mountHero(action: Parameters<typeof HeroActionBody>[0]['action']): ArcadeEventListener | null {
  let listener: ArcadeEventListener | null = null;
  const session = {
    state: () => new Int32Array(16),
    onEvents: (next: ArcadeEventListener) => {
      listener = next;
      return () => undefined;
    },
  };
  HeroActionBody({ action, session, h: 1, children: null });
  for (const effect of hooks.effects) effect();
  return listener;
}

const effect = (kind: string): ArcadeEffect => ({ kind }) as unknown as ArcadeEffect;

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.played.length = 0;
  hooks.refs.length = 0;
  hooks.frame = null;
});

describe('hero action sound wiring', () => {
  it('a swing from a kernel event plays the action’s own sound', () => {
    const listener = mountHero('stir');
    expect(listener).not.toBeNull();
    listener!([effect('score')], 10);
    expect(hooks.played).toEqual(['stir']);
  });

  it('what happened to the hero stays silent here', () => {
    mountHero('sweep')!([effect('damage'), effect('lose')], 10);
    expect(hooks.played).toEqual([]);
  });

  it('an event every tick swings and sounds once per swing, and again after a restart', () => {
    // Opravář v továrně (P37B T9) dostával `count` skoro každý tik: ~50 zvuků za sekundu.
    const listener = mountHero('fix')!;
    for (let tick = 10; tick < 70; tick += 1) listener([effect('count')], tick);
    expect(hooks.played).toEqual(['fix', 'fix']);
    listener([effect('count')], 3);
    expect(hooks.played).toHaveLength(3);
  });

  it('a swing started by one event runs to its end while events keep coming every tick', () => {
    // Přežil mutant z kontroly B: `pending = true` nad podmínkou čekání vrátí nápřah,
    // který každý tik začíná znovu a nikdy nedoběhne – zvuk přitom sedí.
    const listener = mountHero('fix')!;
    const pose = { position: { y: 0, set: () => undefined }, rotation: { set: () => undefined } };
    const [body, prop] = hooks.refs;
    body.current = pose;
    prop.current = pose;
    const clock = hooks.refs.find((ref) => (ref.current as { burstAt?: number }).burstAt !== undefined)!
      .current as { t: number; burstAt: number };
    listener([effect('count')], 10);
    hooks.frame!(null, 1 / 60);
    const swingStart = clock.burstAt;
    for (let tick = 11; tick < 30; tick += 1) {
      listener([effect('count')], tick);
      hooks.frame!(null, 1 / 60);
    }
    expect(clock.burstAt).toBe(swingStart);
    expect(clock.t - clock.burstAt).toBeGreaterThan(0.3);
  });

  it('a hero without an action listens to nothing', () => {
    expect(mountHero('none')).toBeNull();
  });
});

describe('effects bus sound wiring', () => {
  // `Effects` potřebuje plátno, three.quarks a okno – jako funkce se zavolat nedá.
  // Hlídá se tedy zdroj (vzor `hero-action-wiring.test.tsx`): posluchač sběrnice zahraje `busPresets`.
  it('the bus listener plays every preset of the tick', () => {
    const source = readFileSync(join(__dirname, '..', 'effects', 'Effects.tsx'), 'utf8');
    const listener = /created\.subscribe\(\(events\) => \{[\s\S]*?\n {4}\}\);/.exec(source)?.[0] ?? '';
    expect(listener).toMatch(/^\s*for \(const preset of busPresets\(events\)\) playSfx\(preset\);$/m);
  });
});
