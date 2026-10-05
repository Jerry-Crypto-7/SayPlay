/**
 * Prázdný slot ducha (P37-0 T3): bez ducha nevrátí žádný element, takže
 * scéna nedostane objekt ani draw call; a každá hra ho má právě jeden – se
 * dvěma by se duch kreslil dvakrát (běžec, plošinovka, střelnice, hod a řízení
 * jdou přes `World`, úkol hraje v aréně).
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a `useFrame` nahrazuje malá
 * náhrada, scény se volají jako funkce a čte se jejich strom elementů
 * (vzor `target-layer-mount.test.tsx`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { questSpatial, questStation } from '@/play/arcade/pieces/quest';
import { packInputs } from '@/play/score/dare';
import { readGameSpec } from '@/play/spec';

import ArcadeStage from '../ArcadeStage';
import { ArenaWorld } from '../arena/ArenaScene';
import { TargetsMount } from '../arena/TargetsMount';
import { DuelScene } from '../duel/DuelScene';
import { Ghost, type GhostPlacement } from '../Ghost';
import { type ArcadeGhost, type GhostPose, GhostSlot, besideHero, loadGhost } from '../GhostSlot';
import { PlatformWorld } from '../platform/PlatformWorld';
import { StationScene } from '../quest/StationScene';
import { TargetStates } from '../quest/TargetStates';
import { RhythmScene } from '../rhythm/RhythmScene';
import { RunnerWorld } from '../runner/RunnerWorld';
import type { ArcadeSession } from '../session';
import { ShooterRig } from '../shooter/ShooterRig';
import { SteerBackdrop } from '../steer/SteerScene';
import { ThrowRig } from '../throw/ThrowRig';
import { TimingScene, initialBody } from '../timing/TimingScene';
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
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: () => undefined,
  useThree: (select: (three: { camera: PerspectiveCamera; gl: unknown }) => unknown) => select({ camera: new PerspectiveCamera(), gl: { domElement: { closest: () => null } } }),
}));

type Element = ReactElement<Record<string, unknown>>;

/**
 * Scény, do kterých test vstoupí; ostatní komponenty (modely, rig, efekty) slot nenesou a jen se projdou jejich děti.
 * Vrstva cílů úkolu (`TargetsMount` → `TargetStates` → `StationScene`) běží na háčcích, které náhrada nemá –
 * že slot nenese, hlídá poslední test nad zdrojem.
 */
const SCENES = new Set<unknown>([RunnerWorld, PlatformWorld, World, ShooterRig, ThrowRig, SteerBackdrop, DuelScene, TimingScene, RhythmScene, ArenaWorld]);
/** Neexportované vnitřky: plátno za hranicí `memo` a dvě podoby arény. */
const INNER = new Set(['StageCanvas', 'StyledWorld', 'AgarWorld']);

/** Sloty ducha, které strom opravdu postaví, i s props, které dostaly. */
function slotsOf(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => slotsOf(child));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  if (element.type === GhostSlot) return [element];
  const memo = element.type as { readonly type?: unknown };
  const component = typeof element.type === 'object' && memo.type !== undefined ? memo.type : element.type;
  if (typeof component === 'function' && (SCENES.has(component) || INNER.has(component.name))) {
    return slotsOf((component as (props: unknown) => ReactNode)(element.props));
  }
  return slotsOf(element.props.children as ReactNode);
}

const slots = (node: ReactNode): number => slotsOf(node).length;

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

function questWorld(parts: ReturnType<typeof questSpatial.parts>): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const cast = { player: '', enemy: '', chaser: '', props: {} };

describe('ghost slot (P37-0 T3)', () => {
  it('without a ghost renders nothing – no object, no draw call', () => {
    expect(GhostSlot({ session: sessionOf(fixtureWorld('runner')) })).toBeNull();
  });

  it.each(['runner', 'platform', 'flap', 'steer', 'shooter', 'throw', 'arena', 'duel', 'timing', 'rhythm'])('a %s game mounts exactly one slot', (fixture) => {
    const world = fixtureWorld(fixture);
    expect(slots(ArcadeStage({ session: sessionOf(world), cast, enabled: false }))).toBe(1);
  });

  it.each([
    ['spatial', () => questWorld(questSpatial.parts(1, questSpatial.params.parse({ verb: 'put-out', states: 3 }), undefined))],
    ['station', () => questWorld(questStation.parts(1, questStation.params.parse({ verb: 'flip', states: 3 }), undefined))],
  ] as const)('a %s quest game mounts exactly one slot, the arena one', (_mode, world) => {
    expect(slots(ArcadeStage({ session: sessionOf(world()), cast, enabled: false }))).toBe(1);
  });

  it('the quest target layer and station hold no slot of their own', () => {
    for (const component of [TargetsMount, TargetStates, StationScene]) expect(component).toBeTypeOf('function');
    const sources = ['arena/TargetsMount.tsx', 'quest/TargetStates.tsx', 'quest/StationScene.tsx'].map((file) => readFileSync(join(process.cwd(), 'src/components/play/arcade', file), 'utf8'));
    expect(sources.filter((source) => source.includes('<GhostSlot'))).toEqual([]);
  });
});

/**
 * Zapojení ducha (P37B T8): stage podá ducha z `ArcadePlay` slotu každé scény,
 * scéna s tratí převádí pózu jako `World` (výchozí `place`), souboj, načasování
 * a rytmus nesou v `z` počítadlo, a tak ducha postaví vedle hrdiny.
 */
describe('ghost wiring (P37B T8)', () => {
  const ghost: ArcadeGhost = { source: { poseAt: () => null }, label: 'friend' };
  const TRACKED = ['runner', 'platform', 'flap', 'steer', 'shooter', 'throw', 'arena'];
  const BESIDE = ['duel', 'timing', 'rhythm'];

  it.each([...TRACKED, ...BESIDE])('a %s game hands the stage ghost and the session to its slot', (fixture) => {
    const session = sessionOf(fixtureWorld(fixture));
    const [slot, ...more] = slotsOf(ArcadeStage({ session, cast, enabled: false, ghost }));
    expect(more).toEqual([]);
    expect(slot?.props.ghost).toBe(ghost);
    expect(slot?.props.session).toBe(session);
  });

  it('a quest game hands the ghost to the arena slot', () => {
    const world = questWorld(questStation.parts(1, questStation.params.parse({ verb: 'flip', states: 3 }), undefined));
    expect(slotsOf(ArcadeStage({ session: sessionOf(world), cast, enabled: false, ghost })).map((slot) => slot.props.ghost)).toEqual([ghost]);
  });

  it.each(TRACKED)('a %s ghost follows the track the way World draws the hero', (fixture) => {
    const [slot] = slotsOf(ArcadeStage({ session: sessionOf(fixtureWorld(fixture)), cast, enabled: false, ghost }));
    expect(slot?.props.place).toBeUndefined();
  });

  it.each(BESIDE)('a %s ghost stands beside the hero, whatever count its z carries', (fixture) => {
    const world = fixtureWorld(fixture);
    const [slot] = slotsOf(ArcadeStage({ session: sessionOf(world), cast, enabled: false, ghost }));
    const place = slot?.props.place as (pose: GhostPose) => GhostPlacement;
    const start = place({ x: 0, y: 0, z: 0, yaw: 0 });
    expect(place({ x: 3 * UNIT, y: UNIT, z: 7 * UNIT, yaw: 1 })).toEqual(start);
    // Hrdina souboje stojí na [0, 0, z], podstava věže a lišta rytmu na počátku.
    const hero = initialBody(world, 0);
    const gap = fixture === 'duel' ? hero.z - start[2] : Math.abs(start[0]);
    expect(gap).toBeGreaterThan(hero.w / 2);
  });

  it('with a ghost the slot draws it with the session, label and placement it got', () => {
    const session = sessionOf(fixtureWorld('duel'));
    const place = besideHero(0, 0, 1, 'z');
    const drawn = GhostSlot({ ghost: { ...ghost, label: 'best' }, session, place }) as Element;
    expect(drawn.type).toBe(Ghost);
    expect(drawn.props).toMatchObject({ source: ghost.source, session, label: 'best', place });
  });
});

/** Odpovědi API podle adresy; jiná adresa = 404. Zapisuje, na co se klient ptal. */
function fetcherOf(routes: Readonly<Record<string, unknown>>): { readonly fetcher: typeof fetch; readonly asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(url);
    return url in routes ? new Response(JSON.stringify(routes[url])) : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

describe('which ghost a game races (P37B T8)', () => {
  const world = fixtureWorld('runner');
  const replay = { v: 1, inputs: packInputs([]), patches: [] };
  const DETAIL = '/api/play/games/g1';
  const dareUrl = (id: string): string => `/api/play/games/g1/dare/${id}`;

  it("a friend's dare wins over the best run, and the best run is not even asked for", async () => {
    const { fetcher, asked } = fetcherOf({ [dareUrl('friend1')]: { replay }, [DETAIL]: { bestDare: { dareId: 'best1' } }, [dareUrl('best1')]: { replay } });
    const found = await loadGhost('g1', 'friend1', world, fetcher);
    expect(found?.label).toBe('friend');
    expect(found?.source.poseAt(0)).not.toBeNull();
    expect(asked).toEqual([dareUrl('friend1')]);
  });

  it("a friend's dare with no stored run gives way to the game's best run", async () => {
    const { fetcher } = fetcherOf({ [dareUrl('friend1')]: { replay: null }, [DETAIL]: { bestDare: { dareId: 'best1' } }, [dareUrl('best1')]: { replay } });
    expect((await loadGhost('g1', 'friend1', world, fetcher))?.label).toBe('best');
  });

  it('without a friend the game races its best run', async () => {
    const { fetcher } = fetcherOf({ [DETAIL]: { bestDare: { dareId: 'best1' } }, [dareUrl('best1')]: { replay } });
    expect((await loadGhost('g1', null, world, fetcher))?.label).toBe('best');
  });

  it("the friend's dare being the best run is not fetched twice", async () => {
    const { fetcher, asked } = fetcherOf({ [dareUrl('same')]: { replay: null }, [DETAIL]: { bestDare: { dareId: 'same' } } });
    expect(await loadGhost('g1', 'same', world, fetcher)).toBeNull();
    expect(asked).toEqual([dareUrl('same'), DETAIL]);
  });

  it.each([
    ['no best run yet', { [DETAIL]: { bestDare: null } }],
    ['a best run that is not a string', { [DETAIL]: { bestDare: { dareId: 7 } } }],
    ['the game gone', {}],
    ['the best run expired', { [DETAIL]: { bestDare: { dareId: 'best1' } } }],
  ] as const)('%s means no ghost', async (_case, routes) => {
    expect(await loadGhost('g1', null, world, fetcherOf(routes).fetcher)).toBeNull();
  });
});
