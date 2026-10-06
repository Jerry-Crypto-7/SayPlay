import { expect, it } from 'vitest';
import { addPhaseBodies, dependsOnSchema, phasesSchema, phaseSpeed } from '../progression';
import { BODY, BUTTON, COUNTER, FLAG, HEADER, bodyBase, targetStateOf, type ArcadeLevel, type InputEvent } from '../../arcade/contract';
import { buildWorld, hashArcade, instantiate, loadProgram, replay, step, type ArcadeLibrary } from '../../arcade/kernel';
import { ARCADE_LIBRARY } from '../../arcade/library';
import { runBot } from '../../arcade/verify';
import { WALKER_CELL, walkerControl, walkerLabyrinth, walkerMaze, walkerPath } from '../../arcade/pieces/walker';
import { walkerBot } from '../../arcade/pieces/walker-bot';
import { legalObjectives, objectiveOrder, objectiveWalkerBot, pacedWalkerControl, type ObjectiveNode } from '../../arcade/pieces/objective-order';

const library: ArcadeLibrary = { ...ARCADE_LIBRARY,
  controls: { ...ARCADE_LIBRARY.controls, walker: walkerControl, paced_walker: pacedWalkerControl },
  rules: { ...ARCADE_LIBRARY.rules, objective_order: objectiveOrder },
  bots: { ...ARCADE_LIBRARY.bots, walker_bot: walkerBot, objective_walker_bot: objectiveWalkerBot } };

it('validates bounded real phases and acyclic named dependencies', () => {
  expect(phasesSchema.safeParse([{ start: 0, speedPercent: 100 }]).success).toBe(true);
  for (const invalid of [[], [{ start: 1, speedPercent: 100 }], [{ start: 0, speedPercent: 200 }], Array.from({ length: 5 }, (_, i) => ({ start: i * 100, speedPercent: 100 }))]) expect(phasesSchema.safeParse(invalid).success).toBe(false);
  expect(dependsOnSchema.safeParse([{ goal: 'gate', prerequisites: ['key'] }, { goal: 'key', prerequisites: [] }]).success).toBe(true);
  for (const invalid of [[{ goal: 'key', prerequisites: ['absent'] }], [{ goal: 'key', prerequisites: ['gate'] }, { goal: 'gate', prerequisites: ['key'] }]]) expect(dependsOnSchema.safeParse(invalid).success).toBe(false);
});

it.each(Array.from({ length: 5 }, (_, index) => index + 1))('seed %i reversed dependencies change the robot route and legal completion order', seed => {
  const completed: string[][] = [];
  const hashes: string[] = [];
  for (const reverse of [false, true]) {
    const params = walkerLabyrinth.params.parse({ size: 7 });
    const base = walkerLabyrinth.parts(seed, params, undefined), map = walkerMaze(seed, 7);
    const path = walkerPath(map, 8, 40);
    const near = path[2]!, far = path.at(-2)!;
    const bodies = [...base.level.bodies];
    const nodes: ObjectiveNode[] = [near, far].map((cell, index) => {
      const body = bodies.length, goal = index === 0 ? 'nearKey' : 'farKey';
      bodies.push({ role: 'thing', kind: goal, x: cell % 7 * WALKER_CELL, y: 0, z: Math.floor(cell / 7) * WALKER_CELL, w: 900, h: 900, d: 900, solid: false });
      return { goal, body, action: 'collect', prerequisites: index === Number(!reverse) ? [index === 0 ? 'farKey' : 'nearKey'] : [] };
    });
    const built = buildWorld({ seed, level: { ...base.level, bodies }, control: base.control,
      bot: { id: 'objective_walker_bot', params: { ...map, speed: 110, nodes } },
      rules: [{ id: 'objective_order', params: { nodes } }, { id: 'time_limit', params: { seconds: 80 } }], health: 3 }, library);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const initial = instantiate(built.world);
    expect(legalObjectives(initial, nodes).map(node => node.goal)).toEqual([reverse ? 'farKey' : 'nearKey']);
    const bot = runBot(built.world, library, { planner: false });
    expect(bot.outcome).toBe('won');
    expect(replay(built.world, [], library).outcome).toBe('lost');
    expect(replay(built.world, bot.inputs, library).hash).toBe(bot.hash);
    const state = instantiate(built.world), program = loadProgram(built.world, library), order: string[] = [];
    let next = 0;
    for (let tick = 0; tick < bot.tick; tick++) {
      const input = bot.inputs[next]?.tick === tick ? bot.inputs[next++]! : { axis: 0, buttons: 0 };
      const before = nodes.map(node => targetStateOf(state, node.body));
      step(state, input, program);
      nodes.forEach((node, index) => { if (before[index] === 0 && targetStateOf(state, node.body) === 1) order.push(node.goal); });
    }
    completed.push(order); hashes.push(hashArcade(state));
    expect(state[HEADER.counters + COUNTER.items]).toBe(2);
  }
  expect(completed).toEqual([['nearKey', 'farKey'], ['farKey', 'nearKey']]);
  expect(hashes[0]).not.toBe(hashes[1]);
});

it('phase additions are bodies that can be picked up and phase speed changes actual motion', () => {
  const phases = phasesSchema.parse([{ start: 0, speedPercent: 75 }, { start: 500, speedPercent: 125, add: [{ role: 'collectible', count: 1 }] }]);
  const map = { size: 7, open: [8, 15, 22, 29, 36] };
  const base: ArcadeLevel = { length: 20_000, bodies: [
    { role: 'player', kind: 'player', x: 4000, y: 0, z: 4000, w: 800, h: 1200, d: 800, solid: false },
    { role: 'goal', kind: 'finish', x: 4000, y: 0, z: 20_000, w: 1000, h: 1600, d: 1000, solid: false },
  ] };
  expect(addPhaseBodies(base, undefined, () => { throw new Error('must not allocate'); })).toBe(base);
  expect(phaseSpeed(110, 12_000, base.length)).toBe(110);
  const level = addPhaseBodies(base, phases, (_phase, role, _ordinal, from) => ({ role, kind: 'coin', x: 4000, y: 0, z: from + 2000, w: 1000, h: 1000, d: 1000, solid: false }));
  const built = buildWorld({ seed: 1, level, control: { id: 'paced_walker', params: { ...map, speed: 110, phases, phaseLength: level.length } },
    bot: { id: 'walker_bot', params: { ...map, speed: 110, goal: 36 } },
    rules: [{ id: 'pickup', params: {} }, { id: 'finish', params: { allItems: true } }, { id: 'time_limit', params: { seconds: 10 } }] }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const state = instantiate(built.world), program = loadProgram(built.world, library), inputs: InputEvent[] = [];
  const velocities = new Set<number>();
  for (let tick = 0; tick < 180 && state[HEADER.runState] === 0; tick++) {
    const input = { tick, axis: 0, buttons: BUTTON.UP }; inputs.push(input);
    step(state, input, program); velocities.add(state[bodyBase(state[HEADER.player]!) + BODY.vz]!);
  }
  expect(velocities).toContain(82); expect(velocities).toContain(137);
  expect(state[bodyBase(2) + BODY.flags]! & FLAG.alive).toBe(0);
  expect(state[HEADER.runState]).toBe(1);
  expect(replay(built.world, inputs, library, state[HEADER.tick]!).hash).toBe(hashArcade(state));
});

it('collecting the key permits opening a physically solid gate; an idle game cannot open it', () => {
  const map = { size: 7, open: [8, 15, 22] };
  const nodes: ObjectiveNode[] = [{ goal: 'key', body: 1, action: 'collect', prerequisites: [] }, { goal: 'gate', body: 2, action: 'open', prerequisites: ['key'] }];
  const built = buildWorld({ seed: 1,
    level: { length: 12_000, bodies: [
      { role: 'player', kind: 'player', x: 4000, y: 0, z: 4000, w: 800, h: 1200, d: 800, solid: false },
      { role: 'thing', kind: 'key', x: 4000, y: 0, z: 8000, w: 700, h: 700, d: 700, solid: false },
      { role: 'thing', kind: 'gate', x: 4000, y: 0, z: 12000, w: 2000, h: 2400, d: 500, solid: true },
    ] }, control: { id: 'walker', params: { ...map, speed: 110 } },
    bot: { id: 'objective_walker_bot', params: { ...map, speed: 110, nodes } },
    rules: [{ id: 'objective_order', params: { nodes } }, { id: 'time_limit', params: { seconds: 20 } }] }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const bot = runBot(built.world, library, { planner: false });
  expect(bot.outcome).toBe('won');
  const state = instantiate(built.world), program = loadProgram(built.world, library);
  let next = 0;
  for (let tick = 0; tick < bot.tick; tick++) {
    const input = bot.inputs[next]?.tick === tick ? bot.inputs[next++]! : { axis: 0, buttons: 0 };
    step(state, input, program);
  }
  expect(state[HEADER.counters + COUNTER.items]).toBe(1);
  expect(state[bodyBase(2) + BODY.flags]! & FLAG.alive).toBe(0);
  expect(targetStateOf(state, 2)).toBe(1);
  expect(replay(built.world, [], library).outcome).toBe('lost');
  expect(replay(built.world, bot.inputs, library).hash).toBe(hashArcade(state));
});
