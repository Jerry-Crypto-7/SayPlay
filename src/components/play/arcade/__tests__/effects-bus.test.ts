/**
 * Sběrnice efektů (P32-0 T5): z týchž událostí jádra vždy táž posloupnost
 * `VisualEvent`, restart i `reset()` zahodí živé částice a otřes a sběrnice
 * do stavu nezapíše nic – ani do zmrazeného.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, FLAG, HEADER, type InputEvent, ROLE, UNIT, bodyBase, setBodyHp } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { readGameSpec } from '@/play/spec';

import { type EffectsSource, type VisualEvent, createEffectsBus } from '../effects/bus';
import { type ArcadeEventListener, type ArcadeSession, createArcadeSession } from '../session';

function worldOf(mechanics: readonly unknown[] = []): ArcadeWorld {
  const spec = readGameSpec({ ...fixture, mechanics });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const world = worldOf();
/** Běžec se životy: náraz ubere život (`damage`), neskončí hned prohrou. */
const livesWorld = worldOf([{ id: 'health', params: { max: 5 } }]);

/** Hráč „ručně“ zahraje záznam tik po tiku – tytéž stisky, které by přišly z klávesnice. */
function playByHand(session: ArcadeSession, inputs: readonly InputEvent[], until: () => boolean = () => false): void {
  let next = 0;
  for (let tick = 0; tick < 90 * 60 && session.snapshot().runState === 'running' && !until(); tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) {
      session.hold(event.axis);
      session.press(event.buttons);
    } else session.hold(0);
    session.stepOnce();
  }
}

function heardFrom(source: EffectsSource, play: () => void): VisualEvent[] {
  const bus = createEffectsBus(source);
  const heard: VisualEvent[] = [];
  bus.subscribe((events) => heard.push(...events));
  play();
  bus.dispose();
  return heard;
}

/**
 * Relace, jejíž stav i efekty jsou zmrazené: zápis do nich hodí v přísném režimu
 * modulu TypeError. `Object.freeze` na `Int32Array` s prvky sám hodí, proto kopie do pole.
 */
function frozenView(session: ArcadeSession): EffectsSource {
  const freeze = (state: Int32Array): Int32Array => Object.freeze(Array.from(state)) as unknown as Int32Array;
  return {
    onEvents: (listener) => session.onEvents((events, tick) => listener(Object.freeze(events.map((event) => Object.freeze({ ...event }))), tick)),
    subscribe: session.subscribe,
    state: () => freeze(session.state()),
    prev: () => freeze(session.prev()),
    humanRun: session.humanRun,
  };
}

describe('effects bus (P32-0 T5)', () => {
  it('the same kernel events give the same VisualEvent sequence', () => {
    const first = createArcadeSession(world);
    const second = createArcadeSession(world);
    const inputs = first.botInputs();
    const a = heardFrom(first, () => playByHand(first, inputs));
    const b = heardFrom(second, () => playByHand(second, inputs));

    expect(first.snapshot().runState).toBe('won');
    expect(a).toEqual(b);
    expect(a.filter((event) => event.kind === 'pickup').length).toBe(first.snapshot().score);
    expect(a.at(-1)?.kind).toBe('win');
    // Sebraná mince: role sběratelné věci a poloha ze stavu po tiku, ve kterém zmizela.
    for (const pickup of a.filter((event) => event.kind === 'pickup')) {
      expect(pickup.role).toBe(ROLE.collectible);
      expect(pickup.z).toBe((first.state()[bodyBase(pickup.body) + BODY.z] as number) / UNIT);
    }
    // Jedna událost na (tik, tělo, druh).
    expect(new Set(a.map((event) => `${event.tick}:${event.body}:${event.kind}`)).size).toBe(a.length);
  });

  it('a restart and reset() drop the live particles and the shake', () => {
    const session = createArcadeSession(livesWorld);
    const bus = createEffectsBus(session);
    // Bez vstupu běžec narazí: zásah hráče = částice i otřes.
    playByHand(session, [], () => bus.shake() > 0);
    expect(bus.shake()).toBe(1);
    expect(bus.live().some((event) => event.kind === 'hit' && event.body === session.state()[HEADER.player])).toBe(true);

    session.restart();
    expect(bus.live()).toEqual([]);
    expect(bus.shake()).toBe(0);

    playByHand(session, [], () => bus.shake() > 0);
    expect(bus.live().length).toBeGreaterThan(0);
    bus.reset();
    expect(bus.live()).toEqual([]);
    expect(bus.shake()).toBe(0);
    bus.dispose();
  });

  it('flashes a hit only where the kernel applies it: real HP loss on a live body', () => {
    // Jádro zásah neživého těla a záporný zásah zahodí (revize P32-0 T4-R3); záblesk tam by ukázal něco, co se nestalo.
    const state = Int32Array.from(world.initial);
    const dead = 2;
    expect((state[bodyBase(1) + BODY.flags] as number) & FLAG.alive).toBe(FLAG.alive);
    state[bodyBase(dead) + BODY.flags] = (state[bodyBase(dead) + BODY.flags] as number) & ~FLAG.alive;
    setBodyHp(state, 1, 3);
    const before = state.slice();
    setBodyHp(state, 1, 1);
    let emit: ArcadeEventListener = () => undefined;
    const source: EffectsSource = {
      onEvents: (listener) => {
        emit = listener;
        return () => undefined;
      },
      subscribe: () => () => undefined,
      state: () => state,
      prev: () => before,
      humanRun: () => true,
    };
    const heard = heardFrom(source, () => {
      emit([{ kind: 'hit', body: 1, by: 0, amount: 2 }], 0);
      emit([{ kind: 'hit', body: 1, by: 0, amount: -2 }], 1);
      emit([{ kind: 'hit', body: dead, by: 0, amount: 2 }], 2);
    });
    // Zásah jiného těla než hráče dal hráč: vedle záblesku i událost akce (P46C T4).
    expect(heard.map((event) => [event.tick, event.body, event.kind])).toEqual([
      [0, 1, 'hit'],
      [0, 1, 'ability'],
    ]);
  });

  it('never writes the simulation: a frozen state passes and the hash does not move', () => {
    const watched = createArcadeSession(world);
    const plain = createArcadeSession(world);
    const inputs = watched.botInputs();
    const heard = heardFrom(frozenView(watched), () => playByHand(watched, inputs));
    playByHand(plain, inputs);

    expect(heard.length).toBeGreaterThan(0);
    expect(hashArcade(watched.state())).toBe(hashArcade(plain.state()));
    expect(watched.inputs()).toEqual(plain.inputs());
  });
});
