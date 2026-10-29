/**
 * `heroAction` ze specu dojde do každé scény (P37-0 T2). Scény ho zatím
 * nekreslí – čte ho stopa vzhledu; tenhle test hlídá, že ho cestou nikdo
 * neztratí ani nepřepíše na `none`. Typy hlídají, že ho každá montáž předá,
 * test hlídá, že předá tu hodnotu, kterou dostala.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a `useFrame` nahrazuje malá
 * náhrada, komponenty se volají jako funkce a čte se jejich strom elementů
 * (vzor `target-layer-mount.test.tsx`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { ArcadeWorld } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { LOOKS, LOOK_IDS } from '@/play/arcade/look';
import { questStation } from '@/play/arcade/pieces/quest';

import ArcadeStage from '../ArcadeStage';
import { ArenaWorld } from '../arena/ArenaScene';
import { TargetsMount } from '../arena/TargetsMount';
import { DuelScene } from '../duel/DuelScene';
import { PlatformWorld } from '../platform/PlatformWorld';
import { RhythmScene } from '../rhythm/RhythmScene';
import { RunnerWorld } from '../runner/RunnerWorld';
import type { ArcadeSession } from '../session';
import { ShooterRig } from '../shooter/ShooterRig';
import { SteerBackdrop } from '../steer/SteerScene';
import { ThrowRig } from '../throw/ThrowRig';
import { TimingScene } from '../timing/TimingScene';
import { World } from '../World';

// Jeden průchod komponentou: stav z inicializace, efekty a snímky se nepouštějí.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
    // Hrací obdélník na výšku (`usePlayRectRef`, P64): mimo plátno nezměřený.
    useContext: () => ({ current: null }),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: () => undefined,
  useThree: (select: (three: { camera: PerspectiveCamera }) => unknown) => select({ camera: new PerspectiveCamera() }),
}));
// Těla scéna čte ze stavu jádra; cestu props to nemění, takže svět bez těl.
vi.mock('../bodies', async (importOriginal) => ({ ...(await importOriginal<typeof import('../bodies')>()), bodiesOf: () => [] }));

type Element = ReactElement<Record<string, unknown>>;

/** Všechny elementy daného typu ve stromu (přes `children`, ne přes vnořené komponenty). */
function findAll(node: ReactNode, type: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => findAll(child, type));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [...(element.type === type ? [element] : []), ...findAll(element.props.children as ReactNode, type)];
}

const look = LOOKS[LOOK_IDS[0]];
const cast = { player: '', enemy: '', chaser: '', props: {} };

function sessionOf(world: ArcadeWorld): ArcadeSession {
  return {
    world,
    state: () => instantiate(world),
    snapshot: () => ({ tick: 0, runState: 'running' }),
    subscribe: () => () => undefined,
    paused: () => false,
  } as unknown as ArcadeSession;
}

/** Svět jen s ovládáním – `ArcadeStage` a `StageCanvas` z něj čtou, kterou scénu postavit. */
// Prázdný svět bez těl: zakřivená trať běžce (P46D T3) z něj čte semínko a počet těl.
const bare = (id: string): ArcadeSession => sessionOf({ seed: 1, control: { id, params: { half: 20_000 } }, rules: [], kinds: [], initial: [0, 0, 0], length: 0 } as unknown as ArcadeWorld);

/** Element `StageCanvas` (memo za hranicí `ArcadeStage`) mezi dětmi stage. */
function canvasHost(stage: Element): Element {
  return ([stage.props.children].flat(3).filter(isValidElement) as Element[]).find((child) => (child.type as { type?: { name?: string } }).type?.name === 'StageCanvas')!;
}

/** Strom `StageCanvas` pro danou relaci se `stir`. */
function canvasOf(session: ArcadeSession): Element {
  const host = canvasHost(ArcadeStage({ session, cast, enabled: false, heroAction: 'stir' }) as Element);
  expect(host.props.heroAction).toBe('stir');
  return (host.type as unknown as { type: (props: unknown) => Element }).type(host.props);
}

describe('heroAction wiring (P37-0 T2)', () => {
  // `ArcadePlay` se jako funkce zavolat nedá (relace, efekty, sonda), a typ prop je volitelný –
  // smazaný nebo špatný řádek by typecheck nechytil. Hlídá se tedy zdroj (vzor `arcade-bundle.test.ts`).
  it('the play shell hands the spec field to the stage', () => {
    const source = readFileSync(join(__dirname, '..', 'ArcadePlay.tsx'), 'utf8');
    const stage = /<ArcadeStage\b[\s\S]*?\n\s*overlay=/.exec(source)?.[0] ?? '';
    // P43 T5: `heroActionOf` vrací pole specu, jen hra hodu bez činnosti dostane `throw` (test v `action-cue`).
    expect(stage).toMatch(/^\s*heroAction=\{heroActionOf\(spec\)\}$/m);
  });

  it.each([
    ['duel', DuelScene],
    ['timing', TimingScene],
    ['rhythm', RhythmScene],
    ['move_free', ArenaWorld],
    ['runner', RunnerWorld],
    ['platform', PlatformWorld],
    ['flap', World],
    ['shooter', World],
    ['throw', World],
    ['steer', World],
  ] as const)('the stage hands it to the %s scene', (control, scene) => {
    const mounted = findAll(canvasOf(bare(control)), scene);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.props.heroAction).toBe('stir');
  });

  it('defaults to none when the stage gets none', () => {
    expect(canvasHost(ArcadeStage({ session: bare('runner'), cast, enabled: false }) as Element).props.heroAction).toBe('none');
  });

  it.each([
    ['runner', RunnerWorld],
    ['platform', PlatformWorld],
  ] as const)('the %s world passes it on to the shared world', (control, scene) => {
    const props = { session: bare(control), cast, surface: { current: null }, scene: look, enabled: false, heroAction: 'spray' } as const;
    const worlds = findAll(scene(props), World);
    expect(worlds).toHaveLength(1);
    expect(worlds[0]!.props.heroAction).toBe('spray');
  });

  it.each([
    ['shooter', ShooterRig],
    ['throw', ThrowRig],
    ['steer', SteerBackdrop],
  ] as const)('the shared world hands it to the %s scene', (control, scene) => {
    const tree = World({ session: bare(control), control, cast, surface: { current: null }, scene: look, enabled: false, heroAction: 'dig' });
    const mounted = findAll(tree, scene);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.props.heroAction).toBe('dig');
  });

  it('the arena hands it to the quest station through the target layer', () => {
    const parts = questStation.parts(1, questStation.params.parse({ verb: 'flip', states: 3 }), undefined);
    const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const props = { session: sessionOf(built.world), half: 20_000, surface: { current: null }, look, cast, heroAction: 'stack' } as const;
    const styled = ArenaWorld(props) as Element;
    expect((styled.type as { name: string }).name).toBe('StyledWorld');
    const tree = (styled.type as (world: typeof props) => Element)(props);
    const mounts = findAll(tree, TargetsMount);
    expect(mounts).toHaveLength(1);
    const layer = mounts[0]!.props.layer as (targets: readonly never[]) => ReactElement<{ readonly station?: { readonly heroAction: string } }>;
    expect(layer([]).props.station?.heroAction).toBe('stack');
  });
});
