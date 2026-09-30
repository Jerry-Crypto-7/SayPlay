/**
 * Částice z událostí jádra (P32A T4): stejný sled událostí pustí stejné výbuchy,
 * strop živých částic drží i při záplavě, reset je zahodí a efekty do hry
 * nesáhnou – replay má s nimi i bez nich tentýž hash.
 */

import { Color } from 'three';
import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, HEADER, type InputEvent } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { readGameSpec } from '@/play/spec';

import { LIVE_TICKS, type VisualEvent, createEffectsBus } from '../effects/bus';
import { type Burst, type BurstLook, PARTICLE_CAP, burstsOf, createParticleDirector } from '../effects/particles';
import { type ArcadeSession, createArcadeSession } from '../session';

function worldOf(): ArcadeWorld {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const world = worldOf();
const LOOK: BurstLook = { collectible: '#fcd34d', debris: '#78716c', land: '#e2e8f0' };
const TICK_S = 1 / 60;

/** Hráč „ručně“ zahraje záznam tik po tiku (postup z `effects-bus.test.ts`). */
function playByHand(session: ArcadeSession, inputs: readonly InputEvent[]): void {
  let next = 0;
  for (let tick = 0; tick < 90 * 60 && session.snapshot().runState === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) {
      session.hold(event.axis);
      session.press(event.buttons);
    } else session.hold(0);
    session.stepOnce();
  }
}

/** Relace s připojenou sběrnicí a režisérem částic, jako na plátně; `spawn` jen počítá. */
function watch(session: ArcadeSession, cap: number) {
  const bursts: Burst[] = [];
  const events: VisualEvent[] = [];
  let disposed = 0;
  const director = createParticleDirector((burst) => {
    bursts.push(burst);
    return { dispose: () => (disposed += 1) };
  });
  const bus = createEffectsBus(session);
  let systems = 0;
  bus.subscribe((heard) => {
    events.push(...heard);
    const now = (heard[0] as VisualEvent).tick * TICK_S;
    director.update(now);
    systems += director.emit(heard.flatMap((event) => burstsOf(event, LOOK)), now, cap);
  });
  return { bursts, events, director, bus, systems: () => systems, disposed: () => disposed };
}

const hueOf = (hex: string): number => new Color(hex).getHSL({ h: 0, s: 0, l: 0 }).h * 360;

describe('particle bursts from kernel events (P32A T4)', () => {
  it('the same event sequence emits the same particle systems', () => {
    const first = createArcadeSession(world);
    const second = createArcadeSession(world);
    const inputs = first.botInputs();
    const a = watch(first, PARTICLE_CAP.high);
    const b = watch(second, PARTICLE_CAP.high);
    playByHand(first, inputs);
    playByHand(second, inputs);

    expect(first.snapshot().runState).toBe('won');
    expect(a.systems()).toBeGreaterThan(0);
    expect(a.systems()).toBe(b.systems());
    expect(a.bursts).toEqual(b.bursts);
    // Sebraná mince jiskří, výhra hodí konfety, dopad po skoku zvíří prach.
    const kinds = new Set(a.bursts.map((burst) => burst.kind));
    for (const kind of ['sparks', 'confetti', 'dust'] as const) expect(kinds, kind).toContain(kind);
  });

  it('a landing follows a jump, never the first tick', () => {
    const session = createArcadeSession(world);
    const watched = watch(session, PARTICLE_CAP.high);
    const inputs = session.botInputs();
    playByHand(session, inputs);
    const lands = watched.events.filter((event) => event.kind === 'land');
    const firstPress = inputs.find((input) => input.buttons !== 0)!;
    expect(lands.length).toBeGreaterThan(0);
    expect(lands[0]!.tick).toBeGreaterThan(firstPress.tick);
    for (const land of lands) expect(land.body).toBe(session.state()[HEADER.player]);
  });

  it('never holds more live particles than the tier allows', () => {
    const hit: VisualEvent = { kind: 'hit', body: 1, role: 0, x: 0, y: 0, z: 5, tick: 0 };
    for (const cap of [PARTICLE_CAP.low, PARTICLE_CAP.high]) {
      const director = createParticleDirector(() => ({ dispose: () => undefined }));
      for (let i = 0; i < 200; i += 1) director.emit(burstsOf(hit, LOOK), 0, cap);
      expect(director.live()).toBe(cap);
    }
    expect(PARTICLE_CAP.low).toBe(500);
    expect(PARTICLE_CAP.high).toBe(2000);
  });

  it('reset and expiry dispose every live system', () => {
    const session = createArcadeSession(world);
    const watched = watch(session, PARTICLE_CAP.high);
    playByHand(session, session.botInputs());
    const { director } = watched;
    expect(director.systems()).toBeGreaterThan(0);
    director.reset();
    expect(director.live()).toBe(0);
    expect(director.systems()).toBe(0);
    expect(watched.disposed()).toBe(watched.bursts.length);

    // Doběhlý život: výbuch zmizí sám, bez resetu.
    director.emit(burstsOf({ kind: 'pickup', body: 1, role: 0, x: 0, y: 0, z: 0, tick: 0 }, LOOK), 10, PARTICLE_CAP.high);
    director.update(10 + (LIVE_TICKS * TICK_S) / 2);
    expect(director.systems()).toBe(1);
    director.update(11);
    expect(director.systems()).toBe(0);
  });

  it('effects on and off give the same replay hash', () => {
    const watched = createArcadeSession(world);
    const plain = createArcadeSession(world);
    const inputs = watched.botInputs();
    const heard = watch(watched, PARTICLE_CAP.low);
    playByHand(watched, inputs);
    playByHand(plain, inputs);

    expect(heard.systems()).toBeGreaterThan(0);
    expect(hashArcade(watched.state())).toBe(hashArcade(plain.state()));
    expect(watched.inputs()).toEqual(plain.inputs());
  });

  it('bursts carry no purple', () => {
    const events: VisualEvent['kind'][] = ['pickup', 'hit', 'death', 'win', 'land'];
    for (const kind of events) {
      for (const burst of burstsOf({ kind, body: 0, role: 0, x: 0, y: 0, z: 0, tick: 0 }, LOOK)) {
        for (const color of burst.colors) {
          const { s } = new Color(color).getHSL({ h: 0, s: 0, l: 0 });
          if (s > 0.15) expect(hueOf(color) < 250 || hueOf(color) > 320, `${burst.kind} ${color}`).toBe(true);
        }
      }
    }
  });
});
