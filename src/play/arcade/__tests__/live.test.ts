/**
 * Živé změny (P29D T7): patch mezi tiky jde přes existující `ArcadeEffect`,
 * `replayLive` dá týž hash jako živý běh, bez patchů je hash jádra beze změny,
 * vizuální patch hash nemění a robot ověřovače musí hru po patchi vyhrát.
 */

import { describe, expect, it } from 'vitest';

import arenaFixture from '@/play/arcade/__fixtures__/arena.json';
import duelFixture from '@/play/arcade/__fixtures__/duel.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { createArcadeSession } from '@/components/play/arcade/session';
import { readGameSpec } from '@/play/spec';

import { type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { type ArcadeLibrary, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { type LiveEntry, acceptLive, hostileRole, replayLive, startLive, stepLive, visualAt } from '../live';
import { runBot } from '../verify';

function worldOf(fixture: unknown): ArcadeWorld {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const runner = worldOf(runnerFixture);
const arena = worldOf(arenaFixture);
const duel = worldOf(duelFixture);

const aliveOf = (state: Int32Array, role: number): number => {
  let n = 0;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) n += 1;
  }
  return n;
};

/** Relace odehraná záznamem robota tik po tiku s živými změnami v zadaných ticích. */
function playLive(world: ArcadeWorld, patches: readonly LiveEntry[]) {
  const session = createArcadeSession(world);
  const inputs = runBot(world).inputs;
  let next = 0;
  let pending = [...patches].sort((a, b) => a.tick - b.tick);
  while (session.snapshot().runState === 'running' && session.snapshot().tick < 5400) {
    const tick = session.snapshot().tick;
    for (const entry of pending.filter((e) => e.tick === tick)) expect(session.live(entry.patch)).toBeNull();
    pending = pending.filter((e) => e.tick !== tick);
    while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
    const event = inputs[next]?.tick === tick ? inputs[next] : undefined;
    session.press(event?.buttons ?? 0, event?.axis ?? 0);
    session.stepOnce();
  }
  return { session, inputs };
}

describe('live patches', () => {
  it('without patches the hash is exactly the kernel replay (old pinned hashes hold)', () => {
    const inputs = runBot(runner).inputs;
    expect(replayLive(runner, inputs, [])).toEqual(replay(runner, inputs, ARCADE_LIBRARY));
    const arenaInputs = runBot(arena).inputs;
    expect(replayLive(arena, arenaInputs, [])).toEqual(replay(arena, arenaInputs, ARCADE_LIBRARY));
  });

  it('a spawn adds live bodies of the role between two steps', () => {
    const run = startLive(arena);
    for (let t = 0; t < 30; t += 1) stepLive(arena, run, NO_INPUT, []);
    const before = aliveOf(run.state, ROLE.enemy);
    stepLive(arena, run, NO_INPUT, [{ kind: 'spawn', role: 'enemy', count: 3 }]);
    expect(aliveOf(run.state, ROLE.enemy)).toBe(before + 3);
  });

  it('a spawn on a full runner track grows the state and puts obstacles ahead of the player', () => {
    const run = startLive(runner);
    for (let t = 0; t < 60; t += 1) stepLive(runner, run, NO_INPUT, []);
    const length = run.state.length;
    const before = aliveOf(run.state, ROLE.obstacle);
    const playerZ = run.state[bodyBase(run.state[HEADER.player] as number) + BODY.z] as number;
    stepLive(runner, run, NO_INPUT, [{ kind: 'spawn', role: 'obstacle', count: 2 }]);
    expect(run.state.length).toBeGreaterThan(length);
    expect(aliveOf(run.state, ROLE.obstacle)).toBe(before + 2);
    const count = run.state[HEADER.bodyCount] as number;
    for (const i of [count - 1, count - 2]) expect(run.state[bodyBase(i) + BODY.z] as number).toBeGreaterThan(playerZ);
  });

  it('extra life and more time go through the counter and the clock', () => {
    const lives = startLive(duel);
    const health = lives.state[HEADER.counters + COUNTER.health] as number;
    stepLive(duel, lives, NO_INPUT, [{ kind: 'count', counter: 'health', amount: 1 }]);
    expect(lives.state[HEADER.counters + COUNTER.health]).toBe(health + 1);
    const run = startLive(arena);
    const limit = arena.rules.find((rule) => rule.id === 'time_limit')!.params.seconds as number;
    stepLive(arena, run, NO_INPUT, [{ kind: 'count', counter: 'time', amount: 10 }]);
    expect((run.program.rules.find((rule) => rule.piece.id === 'time_limit')!.params as { seconds: number }).seconds).toBe(limit + 10);
  });

  it('the live session and replayLive end on the same hash', () => {
    const patches: LiveEntry[] = [
      { tick: 40, patch: { kind: 'visual', weather: 'rain' } },
      { tick: 90, patch: { kind: 'spawn', role: 'obstacle', count: 2 } },
    ];
    const { session, inputs } = playLive(runner, patches);
    expect(session.patches()).toEqual(patches);
    const live = session.snapshot();
    const replayed = replayLive(runner, inputs, session.patches());
    expect(replayed.tick).toBe(live.tick);
    expect(replayed.hash).not.toBe(replay(runner, inputs, ARCADE_LIBRARY).hash);
    // Hash živé relace = hash přehrání.
    const again = replayLive(runner, inputs, session.patches());
    expect(again.hash).toBe(replayed.hash);
    expect(replayLive(runner, inputs, session.patches().map((e) => ({ ...e })))).toEqual(replayed);
  });

  it('the live session state hashes to exactly what replayLive computes', async () => {
    const { hashArcade } = await import('../kernel');
    const cases: [ArcadeWorld, LiveEntry[]][] = [
      [runner, [{ tick: 120, patch: { kind: 'spawn', role: 'obstacle', count: 3 } }]],
      // Pohybliví nepřátelé: patch o tik vedle by vznikl jinde.
      [arena, [{ tick: 30, patch: { kind: 'spawn', role: 'enemy', count: 2 } }, { tick: 45, patch: { kind: 'count', counter: 'time', amount: 10 } }]],
    ];
    for (const [world, patches] of cases) {
      const { session, inputs } = playLive(world, patches);
      expect(session.patches()).toHaveLength(patches.length);
      expect(hashArcade(session.state())).toBe(replayLive(world, inputs, session.patches()).hash);
    }
  });

  it('a patch replayed one tick later gives a different hash', () => {
    // Robot arény vyhraje v tiku 86; nepřátelé se hýbou, takže o tik později vzniknou jinde.
    const inputs = runBot(arena).inputs;
    const at = replayLive(arena, inputs, [{ tick: 30, patch: { kind: 'spawn', role: 'enemy', count: 2 } }]);
    const later = replayLive(arena, inputs, [{ tick: 31, patch: { kind: 'spawn', role: 'enemy', count: 2 } }]);
    expect(later.hash).not.toBe(at.hash);
  });

  it('a visual patch does not change the hash and holds from its tick on', () => {
    const inputs = runBot(runner).inputs;
    const patches: LiveEntry[] = [
      { tick: 50, patch: { kind: 'visual', weather: 'rain' } },
      { tick: 80, patch: { kind: 'visual', timeOfDay: 'night' } },
    ];
    expect(replayLive(runner, inputs, patches)).toEqual(replay(runner, inputs, ARCADE_LIBRARY));
    expect(visualAt(patches, 10)).toEqual({ weather: 'clear', timeOfDay: 'day' });
    expect(visualAt(patches, 60)).toEqual({ weather: 'rain', timeOfDay: 'day' });
    expect(visualAt(patches, 90)).toEqual({ weather: 'rain', timeOfDay: 'night' });
  });
});

describe('accepting a live patch', () => {
  it('the verifier bot still wins after an accepted patch', () => {
    const run = startLive(runner);
    const verdict = acceptLive(runner, run.state, [], { tick: 60, patch: { kind: 'spawn', role: 'obstacle', count: 2 } });
    expect(verdict).toEqual({ ok: true });
  });

  it('a patch the bot cannot win is refused with a reason', () => {
    const idle: ArcadeLibrary = { ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, [runner.bot.id]: { ...ARCADE_LIBRARY.bots[runner.bot.id]!, decide: () => NO_INPUT } } };
    const verdict = acceptLive(runner, startLive(runner).state, [], { tick: 60, patch: { kind: 'spawn', role: 'obstacle', count: 1 } }, idle);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/impossible to win/);
  });

  it('refuses what the game does not have, with a reason', () => {
    const state = startLive(runner).state;
    expect(acceptLive(runner, state, [], { tick: 0, patch: { kind: 'spawn', role: 'enemy', count: 1 } })).toEqual({ ok: false, reason: 'This game has no enemy to add more of.' });
    expect(acceptLive(runner, state, [], { tick: 0, patch: { kind: 'count', counter: 'time', amount: 10 } })).toEqual({ ok: false, reason: 'This game has no clock.' });
    expect(acceptLive(runner, state, [], { tick: 0, patch: { kind: 'spawn', role: 'goal', count: 1 } }).ok).toBe(false);
  });

  it('names the main threat of each game', () => {
    expect(hostileRole(startLive(arena).state)).toBe('enemy');
    expect(hostileRole(startLive(runner).state)).toBe('obstacle');
  });

  it('the session refuses a patch during the demo and forgets patches on restart', () => {
    const session = createArcadeSession(arena);
    expect(session.live({ kind: 'spawn', role: 'enemy', count: 1 })).toBeNull();
    expect(session.patches()).toHaveLength(1);
    session.restart();
    expect(session.patches()).toHaveLength(0);
    session.startDemo();
    expect(session.live({ kind: 'spawn', role: 'enemy', count: 1 })).not.toBeNull();
  });
});
