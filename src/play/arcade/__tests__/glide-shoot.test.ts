import { describe, expect, it } from 'vitest';
import { nativeSpec } from '@/play/compose/native';
import { applyAddons, glideShotHit, makeAddonBot, makeAddonControl } from '../addons';
import { BODY, BUTTON, FLAG, HEADER, bodyBase, type ArcadeWorld } from '../contract';
import { buildWorld, instantiate, replay, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { GLIDE_MODES, glideControl, glideCourse, glideFinish, type GlideCourseParams } from '../pieces/glide';
import { glideBot } from '../pieces/glide-bot';
import { shotHit } from '../pieces/shots';
import { bindRoles } from '../witness';
import { verifyArcade } from '../verify';

// Exercise real pieces before the root production registry/capability gate lands.
const controls = { ...ARCADE_LIBRARY.controls, glide: glideControl };
const bots = { ...ARCADE_LIBRARY.bots, glide_bot: glideBot };
const library: ArcadeLibrary = {
  controls: { ...controls, addon_control: makeAddonControl(controls) },
  bots: { ...bots, addon_bot: makeAddonBot(bots) },
  rules: { ...ARCADE_LIBRARY.rules, glide_finish: glideFinish, glide_shot_hit: glideShotHit },
  generators: { ...ARCADE_LIBRARY.generators, glide_course: glideCourse },
};
function combined(seed: number, mode: GlideCourseParams['mode']) {
  const spec = nativeSpec({ move: 'glide', actions: ['shoot'], objective: mode, threats: mode === 'race' ? ['rival'] : mode === 'escape' ? ['chaser'] : [] }, {
    genre: 'voyage', mode: 'race', hero: 'submarine', setting: 'ocean', cast: [{ label: 'robot', does: 'shoot_at' }],
  });
  const params = glideCourse.params.parse({ mode });
  const parts = applyAddons(glideCourse.parts(seed, params, undefined), { spec, seed, health: undefined });
  expect(parts.issues).toEqual([]);
  const made = buildWorld({ seed, ...parts }, library);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return { world: made.world, roleBindings: bindRoles(spec, made.world) };
}
const bodyWithKind = (world: ArcadeWorld, name: string) => Array.from({ length: world.initial[HEADER.bodyCount]! }, (_, body) => body)
  .find(body => world.kinds[world.initial[bodyBase(body) + BODY.kind]!] === name);

describe('native glide plus forward shooting', () => {
  it.each(GLIDE_MODES)('%s keeps its real objective and shoots named targets for seeds 1-20', mode => {
    for (let seed = 1; seed <= 20; seed++) {
      const made = combined(seed, mode);
      expect(combined(seed, mode).world).toEqual(made.world);
      const verdict = verifyArcade(made.world, library, made.roleBindings);
      expect(verdict.failures, `${mode}/${seed}`).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
      expect(verdict.bot.outcome).toBe('won');
      expect(verdict.replayEqual).toBe(true);
      expect(verdict.bot.inputs.some(input => input.buttons & BUTTON.FIRE)).toBe(true);
      const shots = verdict.witnesses.filter(witness => witness.verb === 'shoot');
      expect(shots.length, `${mode}/${seed}: actual projectile hit`).toBeGreaterThan(0);
      expect(shots.every(witness => witness.run === 'winner' && witness.evidence === 'projectile-hit' && witness.object?.roleId === 'enemy' && witness.object.label === 'robot')).toBe(true);
      expect(verdict.witnesses.some(witness => witness.verb === 'glide' && witness.run === 'winner')).toBe(true);
      if (mode === 'collect') expect(verdict.witnesses.some(witness => witness.verb === 'collect' && witness.run === 'winner')).toBe(true);
      if (mode === 'race') expect(verdict.witnesses.some(witness => witness.verb === 'race' && witness.run === 'winner' && witness.object?.roleId === 'glide_rival')).toBe(true);
      if (mode === 'escape') {
        expect(verdict.witnesses.some(witness => witness.verb === 'escape' && witness.run === 'winner')).toBe(true);
        expect(verdict.witnesses.some(witness => witness.verb === 'chaser' && witness.run === 'probe')).toBe(true);
      }
      if (seed === 1) {
        const withoutFire = verdict.bot.inputs.map(input => ({ ...input, buttons: input.buttons & ~BUTTON.FIRE }));
        expect(replay(made.world, withoutFire, library).outcome, 'same steering without shots must hit a target').toBe('lost');
      }
    }
  }, 120_000);

  it('a hit on the actual kinematic rival awards no point and cannot despawn it', () => {
    const { world } = combined(4, 'race');
    const rival = bodyWithKind(world, 'glide-rival')!;
    expect(rival).toBeDefined();
    const state = instantiate(world), before = state.slice();
    expect(state[bodyBase(rival) + BODY.flags]! & FLAG.kinematic).not.toBe(0);
    const ctx = { state, player: 0, other: rival, source: -1, input: { axis: 0, buttons: BUTTON.FIRE } };
    // This is the rule the kernel dispatches after a genuine projectile hit.
    expect(shotHit.fire(ctx, {})).toContainEqual({ kind: 'despawn', body: rival });
    expect(glideShotHit.fire(ctx, {})).toEqual([]);
    expect(state).toEqual(before);
    const target = bodyWithKind(world, 'enemy')!;
    expect(glideShotHit.fire({ ...ctx, other: target }, {})).toContainEqual({ kind: 'despawn', body: target });
  });
});
