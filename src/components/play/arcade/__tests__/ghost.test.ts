/**
 * Duch (P37C T3): druhé jádro přehraje uložený běh výzvy v kroku s tikem
 * hráče. Uložená výzva přečtená dveřmi `GET …/dare/:dareId` dojede k hashi,
 * který server spočítal při ověření (i se živou změnou); póza je tělo hráče
 * přehrání v tom tiku; za koncem záznamu duch není a restart ho vrátí od
 * tiku 0; hash hráčovy hry je s duchem i bez něj týž (i s Rapierem); tik
 * ducha stojí pod 0,5 ms. Snímek ducha (`ghostFrame`) zmizí s efektem.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as createGame } from '@/app/api/play/games/route';
import { GET as readGame } from '@/app/api/play/games/[id]/route';
import { POST as postDare } from '@/app/api/play/games/[id]/dare/route';
import { GET as readDare } from '@/app/api/play/games/[id]/dare/[dareId]/route';
import { STARTERS } from '@/components/play/starters';
import throwRock from '@/play/arcade/__fixtures__/rules/throw-rock.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_LIMITS, type ArcadeWorld, BODY, HEADER, type InputEvent, NO_INPUT, bodyBase } from '@/play/arcade/contract';
import { outcomeOf, worldHasPhysics } from '@/play/arcade/kernel';
import { replayLive, startLive, stepLive } from '@/play/arcade/live';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { packInputs } from '@/play/score/dare';
import { type GameSpecV1, readGameSpec } from '@/play/spec';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { GHOST_OPACITY, GHOST_VANISH_MS, type GhostMemory, ghostFrame } from '../Ghost';
import { createGhostSource, fetchGhost, ghostRunOf } from '../ghost-source';
import { createArcadeSession, TICK_MS } from '../session';

const CALLER = { 'x-forwarded-for': '203.0.113.21' };

function fixtureWorld(name: string): ArcadeWorld {
  const spec = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${name}.json`), 'utf8')));
  if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(`${name}: ${built.issues.join('; ')}`);
  return built.world;
}

/** Hra s fyzikálním tělesem (vzor `physics-lazy.test.ts`): duch i hráč mají každý svůj svět Rapieru. */
function physicalWorld(): ArcadeWorld {
  const built = arcadeWorldOf({ ...(throwRock as unknown as GameSpecV1), things: [{ role: 'rock', physics: true }] }, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const FIXTURES = ['runner', 'platform', 'flap', 'steer', 'shooter', 'throw', 'arena', 'duel', 'timing', 'rhythm'] as const;
const runner = fixtureWorld('runner');

/** Poloha hrdiny přehrání v každém tiku (index = tik), přehraná ručně týmž výběrem vstupu jako `replayLive`. */
function playerTrack(world: ArcadeWorld, inputs: readonly InputEvent[]): [number, number, number][] {
  const run = startLive(world);
  const at = (): [number, number, number] => {
    const base = bodyBase(run.state[HEADER.player] as number);
    return [run.state[base + BODY.x] as number, run.state[base + BODY.y] as number, run.state[base + BODY.z] as number];
  };
  const track = [at()];
  const byTick = new Map(inputs.map((event) => [event.tick, event] as const));
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(run.state) === 'running'; tick += 1) {
    stepLive(world, run, byTick.get(tick) ?? NO_INPUT, []);
    track.push(at());
  }
  return track;
}

const xyz = (pose: { x: number; y: number; z: number } | null) => (pose === null ? null : [pose.x, pose.y, pose.z]);

describe('ghost of a stored dare (P37C T3)', () => {
  beforeEach(() => {
    __resetProcessVersionStore();
    resetRateWindows();
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('read back through the dare door, it replays to the end hash the server verified – live change included', async () => {
    const post = (path: string, body: unknown) => new Request(`http://play.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...CALLER }, body: JSON.stringify(body) });
    let game: { id: string; world: ArcadeWorld } | null = null;
    for (const { sentence } of STARTERS) {
      const { versionId } = (await (await createGame(post('/api/play/games', { sentence }))).json()) as { versionId: string };
      const read = (await (await readGame(new Request(`http://play.test/api/play/games/${versionId}`, { headers: CALLER }), { params: Promise.resolve({ id: versionId }) })).json()) as { arcade?: ArcadeWorld };
      if (read.arcade?.rules.some((rule) => rule.id === 'out_of_health') === true) {
        game = { id: versionId, world: read.arcade };
        break;
      }
    }
    if (game === null) throw new Error('no starter game has lives');

    // Hráč vyhraje se živou změnou (+2 životy v tiku 30), jako v relaci prohlížeče.
    const session = createArcadeSession(game.world);
    const bot = new Map(runBot(game.world).inputs.map((event) => [event.tick, event] as const));
    while (session.snapshot().runState === 'running' && session.snapshot().tick < ARCADE_LIMITS.maxTicks) {
      const tick = session.snapshot().tick;
      if (tick === 30) expect(session.live({ kind: 'count', counter: 'health', amount: 2 })).toBeNull();
      const event = bot.get(tick);
      if (event !== undefined) session.press(event.buttons, event.axis);
      session.stepOnce();
    }
    expect(session.snapshot().runState).toBe('won');
    const posted = await postDare(post(`/api/play/games/${game.id}/dare`, { inputs: packInputs(session.inputs()), patches: session.patches() }), { params: Promise.resolve({ id: game.id }) });
    expect(posted.status).toBe(201);
    const { dareId } = (await posted.json()) as { dareId: string };

    const urls: string[] = [];
    const door: typeof fetch = async (input) => {
      urls.push(String(input));
      const [, , , , id = '', , dare = ''] = String(input).split('/');
      return readDare(new Request(`http://play.test${String(input)}`, { headers: CALLER }), { params: Promise.resolve({ id, dareId: dare }) });
    };
    const ghost = await fetchGhost(game.id, dareId, game.world, door);
    expect(urls).toEqual([`/api/play/games/${game.id}/dare/${dareId}`]);
    expect(ghost).not.toBeNull();
    const record = (await (await door(urls[0]!)).json()) as { hash: string; ticks: number };
    expect(ghost!.end()).toBeNull();
    expect(ghost!.poseAt(ARCADE_LIMITS.maxTicks)).toBeNull();
    expect(ghost!.end()).toEqual({ tick: record.ticks, outcome: 'won', hash: record.hash });
  });

  it('poses the replayed hero at the very tick the player is on', () => {
    const inputs = runBot(runner).inputs;
    const track = playerTrack(runner, inputs);
    const ghost = createGhostSource(runner, { inputs, patches: [] });
    const end = track.length - 1;
    for (let tick = 0; tick <= end; tick += 1) expect(xyz(ghost.poseAt(tick)), `tick ${String(tick)}`).toEqual(track[tick]);
    // Hrdina se opravdu hýbe – shodu dvou stojících bodů by splnilo cokoli.
    expect(track[end]![2]).toBeGreaterThan(track[0]![2]);
  });

  it('is gone past the end of the record, and a player restart brings it back from tick 0', () => {
    const inputs = runBot(runner).inputs;
    const track = playerTrack(runner, inputs);
    const end = track.length - 1;
    const ghost = createGhostSource(runner, { inputs, patches: [] });
    expect(xyz(ghost.poseAt(end))).toEqual(track[end]);
    expect(ghost.poseAt(end + 1)).toBeNull();
    expect(xyz(ghost.poseAt(end - 1))).toEqual(track[end - 1]);
    expect(xyz(ghost.poseAt(10))).toEqual(track[10]);
    expect(xyz(ghost.poseAt(11))).toEqual(track[11]);
    expect(xyz(ghost.poseAt(0))).toEqual(track[0]);
    expect(ghost.poseAt(-1)).toBeNull();
  });

  describe('the player plays the same game with the ghost as without it', () => {
    beforeAll(async () => {
      await loadRapier();
    });

    it.each([
      ['runner', () => runner],
      ['physics', physicalWorld],
    ] as const)('%s: same end hash with the ghost racing, and the world left untouched', (name, make) => {
      const world = make();
      expect(worldHasPhysics(world)).toBe(name === 'physics');
      const inputs = runBot(world).inputs;
      const alone = replayLive(world, inputs, []).hash;

      // Duch hraje týž běh – nejhorší případ: dva stejné světy Rapieru vedle sebe.
      const ghost = createGhostSource(world, { inputs, patches: [] });
      const player = startLive(world);
      const byTick = new Map(inputs.map((event) => [event.tick, event] as const));
      for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(player.state) === 'running'; tick += 1) {
        ghost.poseAt(tick);
        stepLive(world, player, byTick.get(tick) ?? NO_INPUT, []);
      }
      ghost.poseAt(ARCADE_LIMITS.maxTicks);
      expect(replayLive(world, inputs, []).hash).toBe(alone);
      expect(ghost.end()?.hash).toBe(alone);
      // Restart hráče po duchovi: start světa je pořád týž.
      expect(replayLive(world, inputs, []).hash).toBe(alone);
      ghost.dispose();
    });
  });

  it('reads only the stored run shape; anything else is a dare without a ghost', () => {
    const inputs = runBot(runner).inputs;
    const packed = packInputs(inputs);
    const patch = { tick: 30, patch: { kind: 'count', counter: 'health', amount: 2 } };
    expect(ghostRunOf({ v: 1, inputs: packed, patches: [patch] })).toEqual({ inputs, patches: [patch] });
    for (const broken of [
      null,
      undefined,
      { v: 2, inputs: packed, patches: [] },
      { v: 1, inputs: [1, 2, 3], patches: [] },
      { v: 1, inputs: packed },
      { v: 1, inputs: packed, patches: [{ tick: 30, patch: { kind: 'erase' } }] },
      { v: 1, inputs: packed, patches: [{ tick: 30, patch: { kind: 'count', counter: 'gold', amount: 2 } }] },
      { v: 1, inputs: packed, patches: [{ tick: ARCADE_LIMITS.maxTicks, patch: { kind: 'visual', weather: 'rain' } }] },
    ]) {
      expect(ghostRunOf(broken), JSON.stringify(broken)).toBeNull();
    }
  });

  it('a dare without a ghost, an unknown dare or a failed read leave the game without one', async () => {
    const replay = { v: 1, inputs: packInputs(runBot(runner).inputs), patches: [] };
    const answer = (response: Response | Error): typeof fetch => async () => {
      if (response instanceof Error) throw response;
      return response;
    };
    expect(await fetchGhost('a1', 'b2', runner, answer(Response.json({ replay: null })))).toBeNull();
    expect(await fetchGhost('a1', 'b2', runner, answer(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })))).toBeNull();
    expect(await fetchGhost('a1', 'b2', runner, answer(new TypeError('offline')))).toBeNull();
    expect(await fetchGhost('a1', 'b2', runner, answer(new Response('not json')))).toBeNull();
    expect(await fetchGhost('a1', 'b2', runner, answer(Response.json({ replay })))).not.toBeNull();
  });

  it('one ghost tick costs under 0.5 ms on every genre', async () => {
    await loadRapier();
    const costs: Record<string, number> = {};
    for (const [name, world] of [...FIXTURES.map((fixture) => [fixture, fixtureWorld(fixture)] as const), ['physics', physicalWorld()] as const]) {
      const inputs = runBot(world).inputs;
      let best = Infinity;
      // Nejlepší ze tří: sada běží vedle jiných procesů a jeden zásek měří stroj, ne ducha.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ghost = createGhostSource(world, { inputs, patches: [] });
        const started = performance.now();
        let tick = 0;
        while (tick < ARCADE_LIMITS.maxTicks && ghost.poseAt(tick + 1) !== null) tick += 1;
        best = Math.min(best, (performance.now() - started) / Math.max(1, tick));
        ghost.dispose();
      }
      costs[name] = Number(best.toFixed(4));
    }
    expect(Math.max(...Object.values(costs)), JSON.stringify(costs)).toBeLessThan(0.5);
  });
});

describe('ghost frame (P37C T3)', () => {
  it('draws between the last two ticks like the player, then vanishes with a pop when the record ends', () => {
    const memory: GhostMemory = { shown: false, vanishAt: null };
    expect(ghostFrame(memory, null, null, 0, 0)).toMatchObject({ visible: false });

    expect(ghostFrame(memory, [0, 0, 0, 0], [2, 1, 4, 0], 0.5, 100)).toEqual({ visible: true, at: [1, 0.5, 2, 0], scale: 1, opacity: GHOST_OPACITY });
    expect(ghostFrame(memory, null, [2, 1, 4, 0], 0.5, 116)).toMatchObject({ visible: true, at: [2, 1, 4, 0] });

    // Záznam dojel: stojí, kde skončil, poskočí a zhasne – ne naráz.
    const start = ghostFrame(memory, [2, 1, 4, 0], null, 0.5, 1000);
    expect(start).toMatchObject({ visible: true, at: null, scale: 1, opacity: GHOST_OPACITY });
    const middle = ghostFrame(memory, null, null, 0, 1000 + GHOST_VANISH_MS / 2);
    expect(middle.visible).toBe(true);
    expect(middle.scale).toBeCloseTo(0.65);
    expect(middle.opacity).toBeCloseTo(GHOST_OPACITY / 2);
    expect(ghostFrame(memory, null, null, 0, 1000 + GHOST_VANISH_MS)).toMatchObject({ visible: false });
    expect(ghostFrame(memory, null, null, 0, 5000)).toMatchObject({ visible: false });

    // Restart hráče: póza je zpátky, duch taky.
    expect(ghostFrame(memory, null, [0, 0, 0, 0], 0, 6000)).toEqual({ visible: true, at: [0, 0, 0, 0], scale: 1, opacity: GHOST_OPACITY });
    expect(memory.vanishAt).toBeNull();
  });

  it('reads the same tick fraction the player is drawn with', () => {
    const session = createArcadeSession(runner);
    const fraction = session.advance(TICK_MS * 2.5);
    expect(fraction).toBeCloseTo(0.5);
    expect(session.alpha()).toBe(fraction);
    session.restart();
    expect(session.alpha()).toBe(0);
  });
});
