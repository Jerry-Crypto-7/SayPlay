import { beforeAll, describe, expect, it } from 'vitest';
import type { AssemblyPart } from '../../compose/parts';
import type { GameSpecV1 } from '../../spec';
import { assemblyParts } from '../pieces/assembly-parts';
import { ARCADE_LIBRARY } from '../library';
import { buildWorld, instantiate, loadProgram, step, outcomeOf, replay } from '../kernel';
import { runBot, verifyArcade } from '../verify';
import { BODY, BUTTON, HEADER, NO_INPUT, bodyBase, targetStateOf } from '../contract';
import type { ArcadeParts } from '../addons';
import { compileRecipe } from '../../compose/compile';
import { arcadeWorldOf } from '../compile';
import { loadRapier } from '../physics/world';
import { compose } from '../../compose/compose';
import { extractIntent } from '../../intent/extract';
beforeAll(async () => { await loadRapier(); });

const base: ArcadeParts = {
  control: { id: 'move_free', params: {} }, bot: { id: 'arena_bot', params: {} },
  level: { length: 0, bodies: [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 900, h: 1200, d: 900, solid: false }] },
  rules: [{ id: 'survive_time', params: { seconds: 30 } }, { id: 'time_limit', params: { seconds: 40 } }],
};
function make(kinds: AssemblyPart['kind'][], phases: (0|1)[] = [], override: Partial<ArcadeParts> = {}) {
  const spec = { assemblyParts: kinds.map((kind, i) => ({ kind, role: `part_${i}`, motion: 'fall', phase: phases[i] ?? 0 })) } as GameSpecV1;
  const parts = assemblyParts({ ...base, ...override }, spec, ARCADE_LIBRARY.rules);
  const built = buildWorld({ ...parts, seed: 1, health: 3 }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { parts, world: built.world, state: instantiate(built.world), program: loadProgram(built.world, ARCADE_LIBRARY) };
}

describe('independent assembly gameplay', () => {
  it('leaves games without parts unchanged', () => {
    expect(assemblyParts(base, {} as GameSpecV1, ARCADE_LIBRARY.rules)).toBe(base);
  });
  it('the bot catches genuinely moving prey and replays exactly', () => {
    const { world } = make(['catch']);
    const run = runBot(world, ARCADE_LIBRARY);
    expect(run.outcome).toBe('won');
    expect(run.tick).toBeGreaterThanOrEqual(1800);
    expect(replay(world, run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
  });
  it('idle cannot satisfy a catch even after the native survival goal', () => {
    const { state, program } = make(['catch']);
    for (let i = 0; i < 2500 && outcomeOf(state) === 'running'; i++) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('lost');
  });
  it('a falling hazard moves and damages a player under it', () => {
    const { state, program, parts } = make(['hazard']);
    const part = (parts.rules.find(r => r.id === 'assembly_part')!.params as { part: { body: number } }).part;
    const p = bodyBase(0), b = bodyBase(part.body);
    state[p + BODY.x] = state[b + BODY.x]!; state[p + BODY.z] = state[b + BODY.z]!;
    const startY = state[b + BODY.y]!;
    let damage = false;
    for (let i = 0; i < 80; i++) damage ||= step(state, NO_INPUT, program).some(e => e.kind === 'damage');
    expect(state[b + BODY.y]).toBeLessThan(startY);
    expect(damage).toBe(true);
  });
  it('phase one stays inactive until a real duel is won', () => {
    const { state, program, parts } = make(['duel', 'catch'], [0, 1]);
    const refs = parts.rules.filter(r => r.id === 'assembly_part').map(r => (r.params as { part: { body: number } }).part);
    const foe = bodyBase(refs[0]!.body), prey = bodyBase(refs[1]!.body), p = bodyBase(0);
    state[p + BODY.z] = state[foe + BODY.z]! - 1500;
    const startZ = state[prey + BODY.z]!;
    for (let i = 0; i < 10; i++) step(state, NO_INPUT, program);
    expect(state[prey + BODY.z]).toBe(startZ);
    for (let i = 0; i < 100; i++) step(state, { axis: 0, buttons: BUTTON.ATTACK }, program);
    expect(targetStateOf(state, refs[0]!.body)).toBe(2);
    expect(state[prey + BODY.z]).not.toBe(startZ);
  });
  it('a human attack press lands between bot cadence ticks', () => {
    const { state, program, parts } = make(['duel']);
    const body = (parts.rules.find(r => r.id === 'assembly_part')!.params.part as { body: number }).body;
    state[bodyBase(0) + BODY.z] = state[bodyBase(body) + BODY.z]! - 1500;
    for (let i = 0; i < 7; i++) step(state, NO_INPUT, program);
    expect(step(state, { axis: 0, buttons: BUTTON.ATTACK }, program)).toContainEqual({ kind: 'hit', body, by: 0, amount: 1 });
  });
  it('delivery requires pickup and travel to the destination', () => {
    const { world } = make(['deliver']);
    const run = runBot(world, ARCADE_LIBRARY);
    expect(run.outcome).toBe('won');
  });
  it('a rival can reach the same finish first and defeat an idle player', () => {
    const { state, program } = make(['rival'], [], { level: { ...base.level, length: 6000 } });
    for (let i = 0; i < 500 && outcomeOf(state) === 'running'; i++) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('lost');
    expect(state[HEADER.tick]).toBeLessThan(500);
  });
  it.each([1, 2, 3, 4, 5])('duel followed by escape lasts 30–90 seconds on seed %s', seed => {
    const composition = compose(extractIntent('a samurai duels a bear and then escapes the burning village'), seed);
    const built = arcadeWorldOf(composition.spec, seed);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const run = runBot(built.world, ARCADE_LIBRARY, { roleBindings: built.roleBindings });
    expect(run.outcome).toBe('won');
    expect(run.tick).toBeGreaterThanOrEqual(1800);
    expect(run.tick).toBeLessThanOrEqual(5400);
  });

  it.each((['glide', 'flap', 'run', 'jump', 'drive', 'walk', 'ball', 'roam'] as const).flatMap(move => [1, 2, 3, 4, 5].map(seed => ({ move, seed }))))('$move seed $seed retains movement while catching prey', ({ move, seed }) => {
    const genre = move === 'glide' || move === 'drive' ? 'voyage' : move === 'flap' ? 'flap' : move === 'run' ? 'runner' : move === 'walk' ? 'quest' : move === 'ball' ? 'throw' : move === 'roam' ? 'arena' : 'platformer';
    const spec = compileRecipe({ preset: 'assembled', move, actions: [], objective: 'reach', threats: [],
      content: genre === 'voyage' ? { genre, mode: 'race', hero: 'seal', setting: 'snow' } : genre === 'quest' ? { genre, mode: 'spatial', hero: 'seal', setting: 'snow' } : genre === 'arena' ? { genre, mode: 'collect', hero: 'seal', setting: 'snow' } : { genre, mode: 'default', hero: 'seal', setting: 'snow' },
      parts: [{ kind: 'catch', role: 'part_0', label: 'fish', phase: 0, motion: 'fall' }] });
    const built = arcadeWorldOf(spec, seed);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const run = runBot(built.world, ARCADE_LIBRARY, { roleBindings: built.roleBindings });
    expect(run.outcome, `${move}: ${run.tick}`).toBe('won');
    expect(run.witnesses.some(witness => witness.verb === 'catch'), `${move}: moving contact evidence`).toBe(true);
  });
  it.each(['deliver', 'interact'] as const)('walk navigates the maze to %s a named passenger', kind => {
    const spec = compileRecipe({ preset: 'assembled', move: 'walk', actions: [kind], objective: 'reach', threats: [],
      content: { genre: 'quest', mode: 'spatial', hero: 'rabbit', setting: 'castle' },
      parts: [{ kind, role: 'part_0', label: 'princess', phase: 0, motion: 'fall' }] });
    for (const seed of [1, 2, 3, 4, 5]) {
      const built = arcadeWorldOf(spec, seed);
      if (!built.ok) throw new Error(built.issues.join('; '));
      const run = runBot(built.world, ARCADE_LIBRARY, { roleBindings: built.roleBindings });
      expect(run.outcome, `${kind}/${seed}/${run.tick}`).toBe('won');
      expect(run.witnesses).toContainEqual(expect.objectContaining({ verb: kind, object: expect.objectContaining({ label: 'princess' }) }));
    }
  });
  it.each(['glide', 'walk', 'ball', 'roam', 'run', 'jump', 'flap', 'drive'] as const)('%s moving hazard can actually damage the player', move => {
    const content = move === 'glide' || move === 'drive' ? { genre: 'voyage' as const, mode: 'race' as const, hero: 'robot', setting: 'city' }
      : move === 'walk' ? { genre: 'quest' as const, mode: 'spatial' as const, hero: 'robot', setting: 'city' }
      : move === 'ball' ? { genre: 'throw' as const, mode: 'default' as const, hero: 'robot', setting: 'football field' }
      : move === 'roam' ? { genre: 'arena' as const, mode: 'collect' as const, hero: 'robot', setting: 'city' }
      : { genre: move === 'flap' ? 'flap' as const : move === 'run' ? 'runner' as const : 'platformer' as const, mode: 'default' as const, hero: 'robot', setting: 'city' };
    const spec = compileRecipe({ preset: 'assembled', move, actions: [], objective: 'reach', threats: ['hazard'], content,
      parts: [{ kind: 'hazard', role: 'part_0', label: 'rock', phase: 0, motion: 'fall' }] });
    const built = arcadeWorldOf(spec, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const verdict = verifyArcade(built.world, ARCADE_LIBRARY, built.roleBindings);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'hazard', actor: expect.objectContaining({ label: 'rock' }) }));
  });
  it.each(['glide', 'walk', 'roam', 'run', 'jump', 'flap', 'drive'] as const)('%s races a named rival that can win', move => {
    const content = move === 'glide' || move === 'drive' ? { genre: 'voyage' as const, mode: 'race' as const, hero: 'robot', setting: 'city' }
      : move === 'walk' ? { genre: 'quest' as const, mode: 'spatial' as const, hero: 'robot', setting: 'city' }
      : move === 'roam' ? { genre: 'arena' as const, mode: 'collect' as const, hero: 'robot', setting: 'city' }
      : { genre: move === 'flap' ? 'flap' as const : move === 'run' ? 'runner' as const : 'platformer' as const, mode: 'default' as const, hero: 'robot', setting: 'city' };
    const spec = compileRecipe({ preset: 'assembled', move, actions: [], objective: 'race', threats: ['rival'], content,
      parts: [{ kind: 'rival', role: 'part_0', label: 'bear', phase: 0, motion: 'fall' }] });
    const built = arcadeWorldOf(spec, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const verdict = verifyArcade(built.world, ARCADE_LIBRARY, built.roleBindings);
    expect(verdict.bot.outcome, `${move}/${verdict.bot.tick}`).toBe('won');
    expect(verdict.witnesses, JSON.stringify({ part: built.world.rules.find(r => r.id === 'assembly_part')?.params.part, tick: verdict.bot.tick, idle: verdict.idle })).toContainEqual(expect.objectContaining({ verb: 'rival', actor: expect.objectContaining({ label: 'bear' }) }));
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'race', object: expect.objectContaining({ label: 'bear' }) }));
  });
});
