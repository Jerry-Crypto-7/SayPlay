/**
 * Shadery scény se přeloží paralelně dřív, než plátno odkryje první snímek (P50 T3).
 * Pin: pojistka, která nikdy nevyprší, nebo plátno, které se po překladu nerozběhne,
 * zasekne hru na prázdné ploše jen na GPU s pomalým překladem – v lokálním měření
 * by to nikdo neviděl.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a R3F nahrazuje malá náhrada
 * (vzor `hero-action-wiring.test.tsx`), komponenty se volají jako funkce.
 */

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { PerspectiveCamera, Scene, WebGLRenderTarget } from 'three';
import type { WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArcadeWorld } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { LOOKS, LOOK_IDS } from '@/play/arcade/look';

import ArcadeStage, { PRECOMPILE_LIMIT_MS, Precompile, precompile } from '../ArcadeStage';
import type { ArcadeSession } from '../session';

const hooks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  three: {} as Record<string, unknown>,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => hooks.effects.push(effect),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: () => undefined,
  useThree: (select: (three: Record<string, unknown>) => unknown) => select(hooks.three),
}));

/** Renderer s ručně řízeným překladem: zapíše cíl, do kterého se překládalo. */
function fakeGl(compiled: Promise<unknown>) {
  const gl = {
    target: null as WebGLRenderTarget | null,
    compiledInto: [] as (WebGLRenderTarget | null)[],
    getRenderTarget: () => gl.target,
    setRenderTarget: (target: WebGLRenderTarget | null) => (gl.target = target),
    compileAsync: () => {
      gl.compiledInto.push(gl.target);
      return compiled;
    },
  };
  return gl;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** Kolikrát se slib vyřešil, bez čekání. */
function track(promise: Promise<void>) {
  const state = { done: false };
  void promise.then(() => (state.done = true));
  return state;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  hooks.effects.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('precompile', () => {
  it('compiles into a render target, so programs match the composer, and restores the canvas target', () => {
    const gl = fakeGl(new Promise(() => undefined));
    void precompile(gl as unknown as WebGLRenderer, new Scene(), new PerspectiveCamera());

    expect(gl.compiledInto).toHaveLength(1);
    expect(gl.compiledInto[0]).toBeInstanceOf(WebGLRenderTarget);
    expect(gl.target).toBeNull();
  });

  it('reveals as soon as the parallel compile finishes', async () => {
    const compile = deferred();
    const reveal = track(precompile(fakeGl(compile.promise) as unknown as WebGLRenderer, new Scene(), new PerspectiveCamera()));

    await vi.advanceTimersByTimeAsync(40);
    expect(reveal.done).toBe(false);
    compile.resolve();
    await flush();
    expect(reveal.done).toBe(true);
  });

  it(`reveals after ${PRECOMPILE_LIMIT_MS} ms when the compile never reports back`, async () => {
    const reveal = track(precompile(fakeGl(new Promise(() => undefined)) as unknown as WebGLRenderer, new Scene(), new PerspectiveCamera()));

    await vi.advanceTimersByTimeAsync(PRECOMPILE_LIMIT_MS - 1);
    expect(reveal.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reveal.done).toBe(true);
  });
});

describe('Precompile on the canvas', () => {
  function mount(ready: boolean, compiled: Promise<unknown>) {
    const onReady = vi.fn();
    const invalidate = vi.fn();
    hooks.three = { gl: fakeGl(compiled), scene: new Scene(), camera: new PerspectiveCamera(), invalidate };
    Precompile({ ready, onReady });
    for (const effect of hooks.effects) effect();
    return { onReady, invalidate };
  }

  it('reports ready once the scene compiled', async () => {
    const compile = deferred();
    const { onReady, invalidate } = mount(false, compile.promise);

    expect(onReady).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    compile.resolve();
    await flush();
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('reports ready at the limit when the compile hangs', async () => {
    const { onReady } = mount(false, new Promise(() => undefined));

    await vi.advanceTimersByTimeAsync(PRECOMPILE_LIMIT_MS);
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('asks for the first frame once ready – R3F does not restart the loop after "never"', () => {
    const { invalidate } = mount(true, new Promise(() => undefined));

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(hooks.three.gl).toMatchObject({ compiledInto: [] });
  });
});

type Element = ReactElement<Record<string, unknown>>;

describe('StageCanvas holds the first frame', () => {
  it('starts with the frame loop stopped and Precompile as the last canvas child', () => {
    const world = { seed: 1, control: { id: 'runner', params: {} }, rules: [], kinds: [], initial: [0, 0, 0], length: 0 } as unknown as ArcadeWorld;
    const session = { world, state: () => instantiate(world), snapshot: () => ({ tick: 0, runState: 'running' }), subscribe: () => () => undefined, paused: () => false } as unknown as ArcadeSession;
    const cast = { player: '', enemy: '', chaser: '', props: {} };
    const stage = ArcadeStage({ session, cast, look: LOOKS[LOOK_IDS[0]], enabled: false }) as Element;
    const host = ([stage.props.children].flat(3).filter(isValidElement) as Element[]).find((child) => (child.type as { type?: { name?: string } }).type?.name === 'StageCanvas')!;
    const canvas = (host.type as unknown as { type: (props: unknown) => Element }).type(host.props);
    const children = [canvas.props.children as ReactNode].flat(3).filter(isValidElement) as Element[];

    expect(canvas.props.frameloop).toBe('never');
    expect(children.at(-1)!.type).toBe(Precompile);
    expect(children.at(-1)!.props.ready).toBe(false);
  });
});
