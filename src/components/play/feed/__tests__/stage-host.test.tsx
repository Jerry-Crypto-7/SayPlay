/**
 * Jedno plátno feedu (P54A T5): dvě po sobě připojené `ArcadeStage` s týmž
 * hostitelem nevytvoří vlastní `<Canvas>` – celý feed má jediné plátno
 * `StageHost`. Druhý kontext vypadá na desktopu úplně normálně a na iPhonu
 * shodí stránku až po desítkách přechodů, proto se počítá.
 *
 * Repo nemá vykreslovač R3F ani DOM: háčky Reactu nahrazuje malá náhrada
 * (vzor `ghost-slot.test.tsx`), komponenty se volají jako funkce a čte se
 * jejich strom elementů; efekty se sbírají a pouštějí ručně – připojení
 * a odchod karty.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Canvas } from '@react-three/fiber';

import { arcadeWorldOf } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { readGameSpec } from '@/play/spec';

import ArcadeStage from '../../arcade/ArcadeStage';
import type { ArcadeSession } from '../../arcade/session';
import { HostedCanvas, StageHost } from '../StageHost';
import { createStageTunnel, type StageTunnel } from '../stage-tunnel';

type Effect = () => void | (() => void);
const effects: Effect[] = [];
const refs: { current: unknown }[] = [];

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => refs.shift() ?? { current },
    useEffect: () => undefined,
    useLayoutEffect: (effect: Effect) => {
      effects.push(effect);
    },
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});

type Element = ReactElement<Record<string, unknown>>;

/** Komponenty, do kterých test vstoupí: `ArcadeStage` až po místo plátna. */
const ENTER = new Set(['StageCanvas', 'HostedCanvas', 'HostCanvas', 'StageCanvasRoot']);

/** Všechny elementy stromu, i za hranicí `memo`, portálu a komponent z `ENTER`. */
function elementsOf(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elementsOf(child));
  const portal = node as { readonly children?: ReactNode; readonly containerInfo?: unknown } | null;
  if (portal !== null && typeof portal === 'object' && portal.containerInfo !== undefined) return elementsOf(portal.children);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  const memo = element.type as { readonly type?: unknown };
  const component = typeof element.type === 'object' && memo.type !== undefined ? memo.type : element.type;
  if (typeof component === 'function' && ENTER.has(component.name)) {
    return [element, ...elementsOf((component as (props: unknown) => ReactNode)(element.props))];
  }
  return [element, ...elementsOf(element.props.children as ReactNode)];
}

const canvases = (node: ReactNode): number => elementsOf(node).filter((element) => element.type === Canvas).length;

function sessionOf(world: ArcadeWorld): ArcadeSession {
  const state = instantiate(world);
  return {
    world,
    state: () => state,
    prev: () => state,
    snapshot: () => ({ tick: 0, runState: 'running' }),
    subscribe: () => () => undefined,
    onEvents: () => () => undefined,
    paused: () => false,
  } as unknown as ArcadeSession;
}

function fixtureWorld(name: string): ArcadeWorld {
  const spec = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${name}.json`), 'utf8')));
  if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(`${name}: ${built.issues.join('; ')}`);
  return built.world;
}

const cast = { player: '', enemy: '', chaser: '', props: {} };

/** Místo v DOM, kam karta přesune kontejner plátna – jen to, co tunel volá. */
interface FakeNode {
  parentNode: FakeNode | null;
  readonly kids: Set<FakeNode>;
  appendChild(child: FakeNode): void;
  remove(): void;
}
function fakeNode(): FakeNode {
  const node: FakeNode = {
    parentNode: null,
    kids: new Set(),
    appendChild(child) {
      child.remove();
      child.parentNode = node;
      node.kids.add(child);
    },
    remove() {
      node.parentNode?.kids.delete(node);
      node.parentNode = null;
    },
  };
  return node;
}

/** Připojí místo plátna jedné `ArcadeStage` s hostitelem: vykreslí ho a pustí efekty; vrací odchod karty. */
function mountSlot(host: StageTunnel, scene: string): { readonly slot: FakeNode; readonly unmount: () => void } {
  const slot = fakeNode();
  refs.push({ current: slot });
  effects.length = 0;
  const place = HostedCanvas({ host, frameloop: 'always', children: scene }) as Element;
  expect(place.type).not.toBe(Canvas);
  (place.type as (props: unknown) => ReactNode)(place.props);
  const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function');
  return { slot, unmount: () => cleanups.forEach((cleanup) => cleanup()) };
}

describe('poměr pixelů plátna (P56C T13b)', () => {
  // R3F `configure` při každém překreslení `<Canvas>` nastaví `dpr` z props; plátno musí nést ten, který už má
  // (úroveň kvality rigu na telefonu 1,5), jinak se vrátí na 2.
  it('překreslené plátno nese poměr pixelů, který mu nastavila úroveň kvality', () => {
    const live = { current: null };
    const canvasOf = (): Element => {
      refs.push(live);
      return elementsOf(HostedCanvas({ frameloop: 'always', children: 'scene' })).find((element) => element.type === Canvas)!;
    };
    const first = canvasOf();
    expect(first.props.dpr).toEqual([1, 2]);
    let dpr = 1.5;
    (first.props.onCreated as (state: unknown) => void)({ get: () => ({ viewport: { dpr } }) });
    expect(canvasOf().props.dpr).toBe(1.5);
    dpr = 1;
    expect(canvasOf().props.dpr).toBe(1);
  });
});

describe('jedno plátno feedu (P54A T5)', () => {
  it('ArcadeStage s hostitelem nemá vlastní Canvas a hostitele podá místu plátna; bez něj má jedno jako dnes', () => {
    const host = createStageTunnel(null);
    const world = fixtureWorld('runner');
    expect(canvases(ArcadeStage({ session: sessionOf(world), cast, enabled: false }))).toBe(1);
    const hosted = elementsOf(ArcadeStage({ session: sessionOf(world), cast, enabled: false, host }));
    expect(hosted.filter((element) => element.type === Canvas)).toHaveLength(0);
    expect(hosted.filter((element) => element.type === HostedCanvas).map((element) => element.props.host)).toEqual([host]);
  });

  it('dvě po sobě připojené ArcadeStage s týmž hostitelem = jedno plátno feedu', () => {
    vi.stubGlobal('document', { createElement: () => Object.assign(fakeNode(), { nodeType: 1, style: {}, className: '' }) });
    try {
      let host: StageTunnel | null = null;
      const world = fixtureWorld('runner');
      const feed = StageHost({
        children: (given) => {
          host = given;
          return [ArcadeStage({ session: sessionOf(world), cast, enabled: false, host: given }), ArcadeStage({ session: sessionOf(fixtureWorld('arena')), cast, enabled: false, host: given })];
        },
      });
      expect(host).not.toBeNull();
      expect(canvases(feed)).toBe(1);
      // Tytéž dvě hry bez hostitele: každá vlastní plátno, tedy vlastní WebGL kontext.
      expect(canvases([ArcadeStage({ session: sessionOf(world), cast, enabled: false }), ArcadeStage({ session: sessionOf(fixtureWorld('arena')), cast, enabled: false })])).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('karta další hry převezme plátno, i když předchozí odejde až po ní; poslední odchod plátno uvolní', () => {
    const element = fakeNode();
    const host = createStageTunnel(element as unknown as HTMLElement);
    const first = mountSlot(host, 'scene A');
    expect(host.content()?.node).toBe('scene A');
    expect(element.parentNode).toBe(first.slot);
    const second = mountSlot(host, 'scene B');
    expect(element.parentNode).toBe(second.slot);
    // Předchozí karta odchází až teď: plátno ani scéna další hry se nesmí ztratit.
    first.unmount();
    expect(host.content()?.node).toBe('scene B');
    expect(element.parentNode).toBe(second.slot);
    expect(host.content()?.owner).not.toBe(undefined);
    second.unmount();
    expect(host.content()).toBeNull();
    expect(element.parentNode).toBeNull();
  });

  it('každá karta má vlastního vlastníka, takže scéna další hry se připojí načisto', () => {
    const host = createStageTunnel(null);
    mountSlot(host, 'scene A');
    const a = host.content()?.owner;
    mountSlot(host, 'scene B');
    expect(host.content()?.owner).not.toBe(a);
  });
});
