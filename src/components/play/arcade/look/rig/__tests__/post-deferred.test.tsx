/**
 * Drahé efekty až po prvním snímku (P50 T2). Profil prvního snímku sdílené hry
 * (desktop, 17. 10.): 419 ms hlavní vlákno čeká na překlad 20 programů, z toho
 * ~285 ms AO, SMAA a bloom. Efekty, které po prvním snímku už nenaběhnou,
 * vypadají jen jako „trochu jiná barva“ – proto pin: v prvním snímku skládač jen
 * tónuje a ladí, hned po jeho vykreslení má plnou sadu úrovně a nízká úroveň
 * (bez AO, SMAA i bloomu) se nemění vůbec.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a R3F nahrazuje malá náhrada
 * (jako `grade-wiring.test.tsx`), komponenty se volají jako funkce.
 */

import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping } from '@react-three/postprocessing';
import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOOKS, LOOK_IDS } from '@/play/arcade/look';

import { Grading, Post, useFirstFrameDrawn } from '../Post';
import { TIER_SETTINGS } from '../quality';

const hooks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  frames: [] as (() => void)[],
  state: [] as unknown[],
  cursor: 0,
  dataset: {} as Record<string, string>,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useMemo: (make: () => unknown) => make(),
    useEffect: (effect: () => unknown) => hooks.effects.push(effect),
    useRef: (initial: unknown) => {
      const slot = hooks.cursor++;
      if (hooks.state.length <= slot) hooks.state.push({ current: initial });
      return hooks.state[slot];
    },
    useState: (initial: unknown) => {
      const slot = hooks.cursor++;
      if (hooks.state.length <= slot) hooks.state.push(initial);
      return [hooks.state[slot], (next: unknown) => (hooks.state[slot] = next)];
    },
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useThree: (select: (three: { gl: { domElement: { dataset: Record<string, string> } } }) => unknown) => select({ gl: { domElement: { dataset: hooks.dataset } } }),
  useFrame: (callback: () => void) => hooks.frames.push(callback),
}));

type Element = ReactElement<Record<string, unknown>>;

function findAll(node: ReactNode, type: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => findAll(child, type));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [...(element.type === type ? [element] : []), ...findAll(element.props.children as ReactNode, type)];
}

const look = LOOKS[LOOK_IDS[0]];
const tiers = Object.keys(TIER_SETTINGS) as (keyof typeof TIER_SETTINGS)[];
const costly = (tree: ReactNode) => ({ ao: findAll(tree, N8AO).length, smaa: findAll(tree, SMAA).length, bloom: findAll(tree, Bloom).length });

/** Jeden „render“ háčku: kurzor stavu od začátku, nové callbacky snímku. */
function renderHook(): boolean {
  hooks.cursor = 0;
  hooks.frames.length = 0;
  return useFirstFrameDrawn();
}

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.frames.length = 0;
  hooks.state.length = 0;
  hooks.cursor = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('costly effects wait for the first frame', () => {
  it.each(tiers)('the %s composer only tones and grades before the first frame', (tier) => {
    const tree = Post({ look, family: 'cold', tier, lean: true });

    expect(costly(tree)).toEqual({ ao: 0, smaa: 0, bloom: 0 });
    expect(findAll(tree, EffectComposer)).toHaveLength(1);
    expect(findAll(tree, ToneMapping)).toHaveLength(1);
    expect(findAll(tree, Grading)).toHaveLength(1);
    // Hranování cíle skládače se nemění: jiné `multisampling` by skládač postavilo znovu.
    expect(findAll(tree, EffectComposer)[0]!.props.multisampling).toBe(findAll(Post({ look, family: 'cold', tier }), EffectComposer)[0]!.props.multisampling);
  });

  it.each(tiers)('the %s composer has the tier’s full effect set after the first frame', (tier) => {
    const { ao, aa, bloom } = TIER_SETTINGS[tier];

    expect(costly(Post({ look, family: 'cold', tier, lean: false }))).toEqual({ ao: ao === false ? 0 : 1, smaa: aa === 'smaa' ? 1 : 0, bloom: bloom ? 1 : 0 });
  });

  it('the low tier draws the same composer before and after the first frame', () => {
    expect(costly(Post({ look, family: 'cold', tier: 'low', lean: true }))).toEqual(costly(Post({ look, family: 'cold', tier: 'low', lean: false })));
  });

  it('switches on right after the first frame is drawn, not while it is being prepared', () => {
    vi.useFakeTimers();
    expect(renderHook()).toBe(false);
    // Callback snímku běží PŘED jeho vykreslením (uvnitř téhož requestAnimationFrame);
    // úloha naplánovaná z něj běží až po vykreslení – i když další snímek nepřijde (`demand`).
    for (const frame of hooks.frames) frame();
    expect(renderHook()).toBe(false);
    vi.advanceTimersByTime(0);
    expect(renderHook()).toBe(true);
  });

  it('schedules the switch once however many frames run before it', () => {
    vi.useFakeTimers();
    renderHook();
    const [frame] = hooks.frames;
    frame!();
    frame!();
    frame!();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stays lean while no frame has been drawn', () => {
    vi.useFakeTimers();
    expect(renderHook()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(renderHook()).toBe(false);
  });
});
