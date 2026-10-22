/**
 * Překlad vyměněné scény (`compileForComposer`, T18): React uvolní materiál staré scény nebo náhradní materiál modelu,
 * zatímco se programy nové scény ještě překládají. `compileAsync` three se na uvolněný materiál ptá dál, jeho
 * `currentProgram` už neexistuje a hodí `reading 'isReady'` – na emulovaném Pixelu 7 při přechodu do kola Run!.
 *
 * Repo nemá WebGL: skutečný `WebGLRenderer` three dostane náhradní kontext, který na všechno odpoví a hotovost
 * překladu (`COMPLETION_STATUS_KHR`) řídí test.
 */
import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileForComposer } from '../StageHost';

const COMPLETION_STATUS_KHR = 0x91b1;

/** Kontext WebGL 2, který přijme každé volání; `done` říká, jestli jsou programy přeložené. */
function fakeContext(compiled: { done: boolean }): WebGL2RenderingContext {
  const names = new Map<number, string>();
  const ids = new Map<string, number>();
  const constant = (name: string): number => {
    let id = ids.get(name);
    if (id === undefined) {
      id = 0x10000 + ids.size;
      ids.set(name, id);
      names.set(id, name);
    }
    return id;
  };
  const parameter = (id: number): unknown => {
    const name = names.get(id) ?? '';
    if (name === 'VERSION') return 'WebGL 2.0';
    if (name === 'SHADING_LANGUAGE_VERSION') return 'WebGL GLSL ES 3.00';
    if (name === 'VIEWPORT' || name === 'SCISSOR_BOX') return new Int32Array([0, 0, 1, 1]);
    return 16;
  };
  const methods: Record<string, (...args: never[]) => unknown> = {
    getParameter: (id: number) => parameter(id),
    getExtension: (name: string) => (name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR } : {}),
    getSupportedExtensions: () => ['KHR_parallel_shader_compile'],
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false }),
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    isContextLost: () => false,
    getProgramParameter: (_program: unknown, id: number) => (id === COMPLETION_STATUS_KHR ? compiled.done : names.get(id)?.startsWith('ACTIVE_') ? 0 : true),
    getShaderParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    getShaderSource: () => '',
    getAttribLocation: () => -1,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
  };
  return new Proxy({} as WebGL2RenderingContext, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in methods) return methods[key];
      if (/^[A-Z0-9_]+$/.test(key)) return constant(key);
      return () => ({});
    },
  });
}

function stage(compiled: { done: boolean }) {
  const canvas = { width: 1, height: 1, style: {}, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as HTMLCanvasElement;
  const gl = new WebGLRenderer({ canvas, context: fakeContext(compiled) });
  const leaving = new MeshBasicMaterial();
  const staying = new MeshStandardMaterial();
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), leaving), new Mesh(new BoxGeometry(), staying));
  return { gl, scene, camera: new PerspectiveCamera(), leaving, staying };
}

describe('compileForComposer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles when a material is disposed while its program is still compiling', async () => {
    const compiled = { done: false };
    const { gl, scene, camera, leaving } = stage(compiled);
    let settled = false;
    void compileForComposer({ gl, scene, camera }).then(() => (settled = true));
    leaving.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    compiled.done = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
  });

  it('waits for every material still in the scene', async () => {
    const compiled = { done: false };
    const { gl, scene, camera } = stage(compiled);
    let settled = false;
    void compileForComposer({ gl, scene, camera }).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    compiled.done = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
  });
});
