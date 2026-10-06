import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { scoreTriples } from '../../../../evals/play/p41/score';
import { readGameSpec } from '@/play/spec';
import { compileGenre } from '@/play/genre';
import runner from '../__fixtures__/runner.json';
import steer from '../__fixtures__/steer.json';
import arena from '../__fixtures__/arena.json';
import throwing from '../__fixtures__/throw.json';
import rhythm from '../__fixtures__/rhythm.json';
import duel from '../__fixtures__/duel.json';
import timing from '../__fixtures__/timing.json';
import carry from '../__fixtures__/rules/carry-key.json';
import lever from '../__fixtures__/rules/lever-bridge.json';
import rock from '../__fixtures__/rules/throw-rock.json';
import { arcadeWorldOf } from '../compile';
import { BODY, HEADER, ROLE, bodyBase } from '../contract';
import { runBot, verifyArcade } from '../verify';

function make(raw: unknown) {
  const read = readGameSpec(raw);
  if (!read.ok) throw new Error(read.issues.join('; '));
  const made = arcadeWorldOf(read.value, 7);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made;
}

const shootSpec = { ...runner, addons: ['shoot'], roles: [...runner.roles, { id: 'enemy', kind: 'hazard', label: 'zombie' }] };
const chaseSpec = {
  ...arena, addons: ['chaser'],
  roles: [...arena.roles.map(role => role.kind === 'player' ? { ...role, label: 'cat' } : role), { id: 'chaser', kind: 'chaser', label: 'dog' }],
};

describe('P41 witnesses from actual play', () => {
  it('probes an oncoming runner chaser after settling the previous jump', () => {
    const spec = compileGenre({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest', cast: [{ label: 'wolf', does: 'chase_me' }] });
    for (const seed of [1, 2, 3, 4, 5]) {
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      expect(verdict.bot.outcome).toBe('won');
      expect(verdict.witnesses.some(w => w.verb === 'chaser' && w.run === 'probe'), `seed ${seed}`).toBe(true);
      expect(verdict.replayEqual).toBe(true);
    }
  });
  it.each([
    ['throw', throwing], ['beat', rhythm], ['duel', duel], ['stack', timing],
    ['deliver', carry], ['interact', lever], ['throw', rock],
  ])('%s is witnessed by its actual effect in an existing game', (verb, raw) => {
    const made = make(raw);
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    expect(bot.witnesses.some(w => w.verb === verb), JSON.stringify(bot.witnesses)).toBe(true);
  });

  it('records melee hits and the target knockout', () => {
    const made = make(compileGenre({ genre: 'arena', mode: 'fight', hero: 'knight', setting: 'castle' }));
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    expect(bot.witnesses.some(w => w.verb === 'fight')).toBe(true);
    expect(bot.witnesses.some(w => w.verb === 'defeat')).toBe(true);
  });

  it('records a quest target changing state', () => {
    const made = make(compileGenre({ genre: 'quest', mode: 'spatial', hero: 'wizard', setting: 'forest' }));
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    expect(bot.witnesses.some(w => w.verb === 'interact' && w.evidence === 'target-state')).toBe(true);
  });

  it('proves catching by a patrol with sight, including spawned chasers in waves', () => {
    const made = make(compileGenre({ genre: 'arena', mode: 'escape', hero: 'cat', setting: 'garden', cast: [{ label: 'guard', does: 'chase_me', patrol: true }, { label: 'fish', does: 'collect' }] }));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.witnesses.find(w => w.verb === 'guard')).toMatchObject({ run: 'probe', actor: { label: 'guard' }, object: { label: 'cat' }, evidence: 'caught-in-sight' });
    expect(verdict.witnesses.some(w => w.verb === 'chaser' && w.actor.body >= made.world.initial[HEADER.spawnBase]!)).toBe(true);
    // Únik se váže k roli ve vítězném běhu, ne ke slotu sondy.
    expect(verdict.witnesses.some(w => w.verb === 'escape' && w.object?.roleId === 'hunter' && w.run === 'winner')).toBe(true);
  });

  it('the label guard without actual patrol sight does not prove a guard', () => {
    const made = make({ ...chaseSpec, roles: chaseSpec.roles.map(r => r.label === 'dog' ? { ...r, label: 'guard' } : r) });
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.witnesses.some(w => w.verb === 'chaser')).toBe(true);
    expect(verdict.witnesses.some(w => w.verb === 'guard')).toBe(false);
  });
  it('binds bodies to spec identities without changing the serialized world', () => {
    const made = make(runner);
    expect(canonicalHash(made.world)).toBe('fe86ee7c');
    expect(make(runner).roleBindings).toEqual(made.roleBindings);
    expect(made.roleBindings.find(b => b.body === made.world.initial[HEADER.player])).toMatchObject({ roleId: 'player', label: 'runner', player: true });
    expect(made.roleBindings.filter(b => b.roleId === 'coin').length).toBeGreaterThan(0);
    expect('roleBindings' in made.world).toBe(false);
  });

  it('records movement, collection and finish from a winning run with their bodies', () => {
    const made = make(runner);
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    for (const verb of ['run', 'collect', 'reach']) {
      expect(bot.witnesses.some(w => w.verb === verb && w.run === 'winner' && w.actor.roleId === 'player')).toBe(true);
    }
    const plain = runBot(made.world);
    expect([bot.hash, bot.inputs]).toEqual([plain.hash, plain.inputs]);
  });

  it('removing shooting removes the shot witness even when both games win', () => {
    const made = make(shootSpec);
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    expect(bot.witnesses.find(w => w.verb === 'shoot')).toMatchObject({ object: { roleId: 'enemy', label: 'zombie' }, evidence: 'projectile-hit' });
    const plain = make({ ...shootSpec, addons: [] });
    expect(runBot(plain.world, undefined, { roleBindings: plain.roleBindings }).witnesses.some(w => w.verb === 'shoot')).toBe(false);
  });

  it('proves overtaking separately from finishing a race', () => {
    const made = make(steer);
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    expect(bot.witnesses.find(w => w.verb === 'race')).toMatchObject({ evidence: 'overtake', object: { roleId: 'rival' } });
    expect(bot.witnesses.some(w => w.verb === 'reach')).toBe(true);
  });

  it('proves danger in a separate run and escape only in the winning run', () => {
    const made = make(chaseSpec);
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.witnesses.find(w => w.verb === 'chaser')).toMatchObject({ run: 'probe', actor: { label: 'dog' }, object: { label: 'cat' } });
    expect(verdict.witnesses.find(w => w.verb === 'escape')).toMatchObject({ run: 'winner', actor: { label: 'cat' }, object: { label: 'dog' } });
    expect(verdict.witnesses.filter(w => w.run === 'probe').some(w => w.verb === 'escape')).toBe(false);
  });

  it('swapping identities on exactly the same geometry reverses the proven triple', () => {
    const made = make(chaseSpec);
    const first = verifyArcade(made.world, undefined, made.roleBindings).witnesses;
    const swapped = made.roleBindings.map(b => b.label === 'cat' ? { ...b, label: 'dog' } : b.label === 'dog' ? { ...b, label: 'cat' } : b);
    const second = verifyArcade(made.world, undefined, swapped).witnesses;
    const wanted = [{ actor: 'dog', verb: 'chaser', object: 'cat' }];
    expect(scoreTriples(wanted, first).preserved).toBe(true);
    expect(scoreTriples(wanted, second).preserved).toBe(false);
  });

  it('dog catches cat is not cat catches dog on identical geometry', () => {
    const made = make({ ...arena, roles: arena.roles.map(r => r.kind === 'player' ? { ...r, label: 'dog' } : r.id === 'hunter' ? { ...r, label: 'cat' } : r) });
    // Připravená honička: malá kořist poblíž startu. Běžný agar lze vyhrát jen potravou bez chycení.
    const initial = [...made.world.initial];
    const prey = made.roleBindings.find(b => b.roleId === 'hunter')!;
    initial[bodyBase(prey.body) + BODY.x] = 1000;
    initial[bodyBase(prey.body) + BODY.z] = 0;
    const world = { ...made.world, initial };
    const swapped = made.roleBindings.map(b => b.label === 'cat' ? { ...b, label: 'dog' } : b.label === 'dog' ? { ...b, label: 'cat' } : b);
    const first = runBot(world, undefined, { roleBindings: made.roleBindings });
    const second = runBot(world, undefined, { roleBindings: swapped });
    expect(first.outcome).toBe('won');
    expect(first.hash).toBe(second.hash);
    const wanted = [{ actor: 'dog', verb: 'catch', object: 'cat' }];
    expect(scoreTriples(wanted, first.witnesses).preserved).toBe(true);
    expect(scoreTriples(wanted, second.witnesses).preserved).toBe(false);
  });

  it('a harmless chaser cannot prove either a threat or escape', () => {
    const made = make(chaseSpec);
    const safe = { ...made.world, rules: made.world.rules.filter(r => !(r.id === 'hit' && r.params.role === 'chaser')) };
    const verdict = verifyArcade(safe, undefined, made.roleBindings);
    expect(verdict.witnesses.some(w => w.verb === 'chaser' || w.verb === 'escape')).toBe(false);
  });

  it('a motionless body labelled chaser is not a proven pursuit', () => {
    const made = make(chaseSpec);
    const safe = { ...made.world, control: (made.world.control.params.base as typeof made.world.control) };
    const verdict = verifyArcade(safe, undefined, made.roleBindings);
    expect(verdict.witnesses.some(w => w.verb === 'chaser' || w.verb === 'escape')).toBe(false);
  });

  it('hazards hurt in probes, never masquerading as a successful escape', () => {
    const made = make(runner);
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.witnesses.some(w => w.run === 'probe' && w.verb === 'obstacle' && w.actor.roleId === 'obstacle')).toBe(true);
    expect(verdict.witnesses.some(w => w.run === 'probe' && w.verb === 'escape')).toBe(false);
  });

  it('a win or score labelled shoot does not prove shooting', () => {
    const raw = { ...arena, rules: [{ id: 'fake_shot', when: { contact: ['player', 'coin'] }, do: [{ score: 1 }, { win: true }], verb: 'shoot' }] };
    const made = make(raw);
    const bot = runBot(made.world, undefined, { roleBindings: made.roleBindings });
    expect(bot.outcome).toBe('won');
    expect(bot.witnesses.some(w => w.verb === 'shoot')).toBe(false);
    expect(bot.witnesses.some(w => w.verb === 'score')).toBe(true);
  });

  it('all essential triples must match, including an explicitly admitted omission', () => {
    const made = make(runner);
    const witnesses = runBot(made.world, undefined, { roleBindings: made.roleBindings }).witnesses;
    const wanted = [{ actor: 'hero', verb: 'run', object: null }, { actor: 'hero', verb: 'shoot', object: 'zombie' }];
    expect(scoreTriples(wanted, witnesses, [wanted[1]!])).toMatchObject({ preserved: false, missing: [wanted[1]], silent: [] });
  });

  it('does not invent identities for a retained but unbound enemy body', () => {
    const made = make(shootSpec);
    const bindings = made.roleBindings.filter(b => made.world.initial[bodyBase(b.body) + BODY.role] !== ROLE.enemy);
    const bot = runBot(made.world, undefined, { roleBindings: bindings });
    expect(scoreTriples([{ actor: 'hero', verb: 'shoot', object: 'zombie' }], bot.witnesses).preserved).toBe(false);
  });
});
