/**
 * Zapojení výkonu arény (P36C T9): rytíř se při načtení slije do jedné sítě
 * a výzva na startu měří hrdinu klidovým kvádrem, ne pózou kostí. Obojí je
 * vidět jen na FPS telefonu – bez slití nebo s pózou každý snímek obraz
 * vypadá stejně a sada zůstane zelená.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a `useFrame` nahrazuje malá
 * náhrada, komponenty se volají jako funkce a čte se jejich strom elementů.
 */

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { Bone, Box3, BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, type Object3D, PerspectiveCamera, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import type { RiggedCharacter } from '@/play/arcade/models';

import ArcadeStage, { frameOf, posedBox } from '../ArcadeStage';
import { RiggedModel } from '../RiggedModel';
import type { ArcadeSession } from '../session';

const hooks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  updates: [] as unknown[],
  after: [] as (() => void)[],
  three: null as unknown,
  gltf: null as unknown,
}));

// Jeden průchod komponentou: stav z inicializace, `setState` jen zapíše, efekt se jen schová – test ho pustí sám.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, (next: unknown) => hooks.updates.push(next)],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => hooks.effects.push(effect),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: () => undefined,
  useThree: (select: (three: { get: () => unknown }) => unknown) => select({ get: () => hooks.three }),
  addAfterEffect: (callback: () => void) => {
    hooks.after.push(callback);
    return () => undefined;
  },
}));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    loadAsync(): Promise<unknown> {
      return Promise.resolve(hooks.gltf);
    }
  },
}));

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.updates.length = 0;
  hooks.after.length = 0;
});

/** Riggované tělo s vahou na jedinou kost (kost visí vedle těla – síť s dětmi `mergeRig` nechá být). */
function skinnedBody(bone: Bone, material: MeshStandardMaterial): SkinnedMesh {
  const geometry = new BoxGeometry(0.5, 1.8, 0.3);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(count * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const body = new SkinnedMesh(geometry, material);
  body.bind(new Skeleton([bone]));
  return body;
}

const meshes = (root: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((node) => {
    if ((node as Mesh).isMesh) out.push(node as Mesh);
  });
  return out;
};

/** `PromptSpot` z vykresleného stromu: ArcadeStage → StageCanvas (memo) → Canvas → PromptSpot. */
function promptSpot(): ReactElement<Record<string, unknown>> {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'fight', params: {} },
      rules: [],
      bot: { id: 'fight_bot', params: {} },
      level: { bodies: [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false }], length: 0 },
    },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  const state = instantiate(built.world);
  const session = {
    world: built.world,
    state: () => state,
    snapshot: () => ({ tick: 0, runState: 'running' }),
    subscribe: () => () => undefined,
    paused: () => false,
  } as unknown as ArcadeSession;

  const stage = ArcadeStage({ session, cast: { player: '', enemy: '', chaser: '', props: {} }, enabled: false }) as ReactElement<{ readonly children: ReactNode }>;
  const children = (element: ReactElement<{ readonly children?: ReactNode }>): ReactElement<Record<string, unknown>>[] =>
    [element.props.children].flat(3).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
  const canvasHost = children(stage).find((child) => (child.type as { type?: { name?: string } }).type?.name === 'StageCanvas')!;
  const stageCanvas = (canvasHost.type as unknown as { type: (props: unknown) => ReactElement<{ readonly children: ReactNode }> }).type;
  return children(stageCanvas(canvasHost.props)).find((child) => (child.type as { name?: string }).name === 'PromptSpot')!;
}

describe('arena perf wiring (P36C T9)', () => {
  it('merges a loaded rigged character into one skinned mesh before it is drawn', async () => {
    const material = new MeshStandardMaterial();
    const bone = new Bone();
    const scene = new Group();
    const body = skinnedBody(bone, material);
    scene.add(bone, body);
    // Meč na kosti, stejný materiál – rytíř KayKit takových nese devět.
    bone.add(new Mesh(new BoxGeometry(0.1, 1.2, 0.1), material));
    hooks.gltf = { scene, animations: [] };
    expect(meshes(scene)).toHaveLength(2);

    const character = { path: '/models/perf-wiring-knight.glb', clips: {} } as unknown as RiggedCharacter;
    RiggedModel({ character, h: 1.8, clip: () => 'idle', fallback: '#888888' });
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.updates).toHaveLength(1));

    const loaded = (hooks.updates[0] as GLTF).scene;
    const left = meshes(loaded);
    expect(left).toHaveLength(1);
    expect((left[0] as SkinnedMesh).isSkinnedMesh).toBe(true);
  });

  it('places the start prompt by the rest box and never skins the hero per frame', () => {
    const spot = promptSpot();
    expect(spot).toBeDefined();

    const bone = new Bone();
    const hero = skinnedBody(bone, new MeshStandardMaterial());
    hero.userData.frame = 'hero';
    hero.position.z = 6;
    const world = new Scene().add(bone, hero);
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.lookAt(0, 0, 6);
    world.updateMatrixWorld(true);
    // Vazba v místě postavy: póza kostí i klidový kvádr stojí stejně před kamerou, liší se jen cenou.
    hero.bind(hero.skeleton, hero.matrixWorld);
    camera.updateMatrixWorld();
    hooks.three = { camera, scene: world, size: { width: 400, height: 800 } };
    const properties = new Map<string, string>();
    const setProperty = vi.fn((name: string, value: string) => properties.set(name, value));
    const host = {
      dataset: {} as Record<string, string>,
      style: { setProperty, getPropertyValue: (name: string) => properties.get(name) ?? '' },
      getBoundingClientRect: () => ({ top: 0, height: 800 }),
      querySelector: () => null,
      parentElement: null,
    };

    hooks.effects.length = 0;
    (spot.type as (props: unknown) => unknown)({ ...spot.props, surface: { current: host } });
    for (const effect of hooks.effects) effect();
    expect(hooks.after).toHaveLength(1);

    const skin = vi.spyOn(hero, 'computeBoundingBox');
    hooks.after[0]!();
    // Výzva se opravdu postavila podle hrdiny…
    expect(host.dataset.promptAt).toBeDefined();
    expect(properties.has('--_hero-top')).toBe(true);
    // …a kosti tu nikdo nepřepočítal.
    expect(skin).not.toHaveBeenCalled();
  });

  it('writes the prompt style and searches for the hero only when something changed (P37B T7)', () => {
    // Bez toho karta každý snímek tiku 0 zneplatní rozvržení a projde scénu – obraz je stejný, jen telefon pomalejší.
    const spot = promptSpot();
    const hero = new Mesh(new BoxGeometry(0.5, 1.8, 0.3), new MeshStandardMaterial());
    hero.userData.frame = 'hero';
    hero.position.z = 6;
    const world = new Scene().add(hero);
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.lookAt(0, 0, 6);
    world.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    hooks.three = { camera, scene: world, size: { width: 400, height: 800 } };
    const properties = new Map<string, string>();
    const setProperty = vi.fn((name: string, value: string) => properties.set(name, value));
    const host = {
      dataset: {} as Record<string, string>,
      style: { setProperty, getPropertyValue: (name: string) => properties.get(name) ?? '' },
      getBoundingClientRect: () => ({ top: 0, height: 800 }),
      querySelector: () => null,
      parentElement: null,
    };

    hooks.effects.length = 0;
    (spot.type as (props: unknown) => unknown)({ ...spot.props, surface: { current: host } });
    for (const effect of hooks.effects) effect();
    const search = vi.spyOn(world, 'traverseVisible');
    for (let frame = 0; frame < 4; frame += 1) hooks.after[0]!();
    expect(setProperty).toHaveBeenCalledTimes(3);
    expect(search).toHaveBeenCalledTimes(1);

    // Hrdina se schová (výměna modelu) → hledá se znovu, a když není, karta místo pustí.
    hero.visible = false;
    hooks.after[0]!();
    expect(search).toHaveBeenCalledTimes(2);
    expect(host.dataset.promptAt).toBeUndefined();
  });

  it('measures the bone pose exactly like three without skinning each vertex per bone (P58A T9r1)', () => {
    // Čitelná těla (`LegibleBodies`) měří pózu 4× za sekundu; `computeBoundingBox` three násobí matici kosti
    // u každého vrcholu a váhy – ork a kovboj tak stáli na telefonu pětinu FPS a obraz vypadal stejně.
    const root = new Bone();
    const arm = new Bone();
    arm.position.y = 0.9;
    root.add(arm);
    const geometry = new BoxGeometry(0.5, 1.8, 0.3, 2, 4, 2);
    const position = geometry.getAttribute('position');
    // Horní půlka dvěma kostmi (0,7 paže, 0,3 kořen), dolní jen kořenem.
    const index = new Uint16Array(position.count * 4);
    const weight = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i += 1) {
      const upper = position.getY(i) > 0;
      index.set(upper ? [1, 0, 0, 0] : [0, 0, 0, 0], i * 4);
      weight.set(upper ? [0.7, 0.3, 0, 0] : [1, 0, 0, 0], i * 4);
    }
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weight, 4));
    const body = new SkinnedMesh(geometry, new MeshStandardMaterial());
    body.add(root);
    const world = new Scene().add(body);
    // Vazba mimo počátek (`bindMatrix` ≠ jednotková), pak póza: paže se ohne o 60°, kořen se posune.
    body.position.set(1, 0.4, 6);
    body.rotation.y = 0.5;
    world.updateMatrixWorld(true);
    body.bind(new Skeleton([root, arm]));
    arm.rotation.z = Math.PI / 3;
    root.position.x = 0.2;
    world.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(50, 0.5, 0.1, 100);
    camera.lookAt(1, 0.4, 6);
    camera.updateMatrixWorld();

    // Vzor: kvádr pózy, jak ho spočítá three, na dvojčeti se stejnou kostrou a vazbou.
    const twin = body.clone(false);
    twin.computeBoundingBox();
    const reference = twin.boundingBox;
    const skin = vi.spyOn(body, 'applyBoneTransform');
    expect(posedBox(body, new Box3())).toEqual(reference);
    const frame = frameOf(body, camera, 400, 800);
    // Póza se opravdu počítá (ohnutá paže ≠ klidový kvádr) – a three ji po vrcholech nepřepočítal.
    expect(frame).not.toEqual(frameOf(body, camera, 400, 800, false));
    expect(skin).not.toHaveBeenCalled();
    expect(body.boundingBox).toBeNull();
  });
});
