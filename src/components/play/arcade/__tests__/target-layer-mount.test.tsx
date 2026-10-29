/**
 * Zapojení vrstvy cílů (P32G G-R2, z revize P32E T7): vrstva úkolu se dozví
 * o každé změně stavu cíle, i když cíl stojí, a scéna arény jí cíle předá
 * místo kvádrů. Bez toho hráč uhasí strom a vidí ho hořet dál, nebo vidí
 * šedý kvádr – a sada zůstane zelená.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a `useFrame` nahrazuje malá
 * náhrada, komponenty se volají jako funkce a čte se jejich strom elementů.
 */

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { PerspectiveCamera } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLE, setTargetState } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { LOOKS, LOOK_IDS } from '@/play/arcade/look';
import { questSpatial } from '@/play/arcade/pieces/quest';

import { ArenaWorld } from '../arena/ArenaScene';
import { type TargetBody, TargetsMount, targetsOf } from '../arena/TargetsMount';
import { type BodyView, bodiesOf } from '../bodies';
import type { ArcadeSession } from '../session';

const hooks = vi.hoisted(() => ({ frames: [] as (() => void)[], updates: [] as unknown[] }));

// Jeden průchod komponentou: stav z inicializace, `setState` jen zapíše, co by se překreslilo.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, (next: unknown) => hooks.updates.push(next)],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
    useContext: (context: { _currentValue: unknown }) => context._currentValue,
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: (frame: () => void) => hooks.frames.push(frame),
  useThree: (select: (three: { camera: PerspectiveCamera }) => unknown) => select({ camera: new PerspectiveCamera() }),
}));

beforeEach(() => {
  hooks.frames.length = 0;
  hooks.updates.length = 0;
});

/** Hasič v prostoru: hráč, stromy (role cíle) a pronásledovatelé. */
function quest() {
  const parts = questSpatial.parts(1, questSpatial.params.parse({ verb: 'put-out', states: 3 }), undefined);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const state = instantiate(built.world);
  const session = { world: built.world, state: () => state };
  return { state, session, views: bodiesOf(session) };
}

const targetIndices = (views: readonly BodyView[]): number[] => views.filter((view) => view.role === ROLE.target).map((view) => view.index);

describe('target layer mount (P32G G-R2)', () => {
  it('redraws the layer when only a target state changes, and not while nothing does', () => {
    const { state, session, views } = quest();
    const drawn: (readonly TargetBody[])[] = [];
    TargetsMount({ session, views, layer: (targets) => (drawn.push(targets), null) });
    const [first] = targetIndices(views);
    expect(drawn[0]?.find((target) => target.index === first)?.state).toBe(0);

    hooks.frames[0]!();
    expect(hooks.updates).toEqual([]);

    // Hráč uhasil strom: cíl stojí na místě, mění se jen stav.
    setTargetState(state, first!, 1);
    hooks.frames[0]!();
    expect(hooks.updates).toEqual([targetsOf(views, state)]);
    expect((hooks.updates[0] as readonly TargetBody[]).find((target) => target.index === first)?.state).toBe(1);
  });

  it('hands every target body of the arena scene to the layer and draws none of them as a block', () => {
    const { session, views } = quest();
    const props = { session: session as ArcadeSession, half: 20_000, surface: { current: null }, look: LOOKS[LOOK_IDS[0]], cast: { player: '', enemy: '', chaser: '', props: {} }, heroAction: 'none' as const };
    const scene = ArenaWorld(props) as ReactElement<typeof props>;
    const styled = scene.type as (world: typeof props) => ReactElement<{ readonly children: ReactNode }>;
    expect(styled.name).toBe('StyledWorld');

    const children = [styled(props).props.children].flat(2).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    const mounts = children.filter((child) => child.type === TargetsMount);
    expect(mounts).toHaveLength(1);
    const mount = mounts[0]!.props as { readonly views: readonly BodyView[]; readonly layer: unknown };
    const targets = targetIndices(views);
    expect(targets.length).toBeGreaterThan(1);
    expect(targetIndices(mount.views)).toEqual(targets);
    expect(mount.layer).toBeTypeOf('function');

    // Tělesa scéna kreslí pod klíčem svého indexu: hrdina ano, cíl ne.
    const bodies = children.filter((child) => child.key !== null).map((child) => Number(child.key));
    expect(bodies).toContain(views.find((view) => view.role === ROLE.player)!.index);
    expect(bodies.filter((index) => targets.includes(index))).toEqual([]);
  });
});
