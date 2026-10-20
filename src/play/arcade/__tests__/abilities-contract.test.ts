/**
 * Akce hrdiny (P46A T3): pole `abilities` je volitelné a spec bez něj dá
 * tentýž svět, hash i `gameSpecHash` jako dřív (uložené hry se nepohnou).
 * Nejvýš 2 akce, žádná dvakrát a jen ty, které ovládání bere – jinak
 * `MALFORMED_SPEC`. Tlačítka akcí jsou nové bity a staré se nepřečíslují.
 */

import { describe, expect, it } from 'vitest';

import { CAPABILITIES } from '../../capabilities';
import { gameSpecHash, readGameSpec } from '../../spec';
import { ABILITIES, ABILITY_SLOTS, BODY, BUTTON } from '../contract';
import { arcadeWorldOf } from '../compile';
import { hashArcade, instantiate } from '../kernel';
import runner from '../__fixtures__/runner.json';
import platform from '../__fixtures__/platform.json';
import steer from '../__fixtures__/steer.json';
import timing from '../__fixtures__/timing.json';

const read = (fixture: unknown, extra: Record<string, unknown> = {}) => readGameSpec({ ...(fixture as object), ...extra });

describe('P46A abilities contract', () => {
  it('lists the five abilities and two new action buttons without renumbering the old ones', () => {
    expect(ABILITIES).toEqual(['shoot', 'strike', 'dash', 'shield', 'grab']);
    expect(BUTTON).toMatchObject({ TAP: 1, LEFT: 2, RIGHT: 4, UP: 8, DOWN: 16, HOLD: 32, FIRE: 64, ATTACK: 128, INTERACT: 256, ACTION_A: 512, ACTION_B: 1024 });
  });

  it('keeps the ability state in the counter body slots fixed by T1', () => {
    expect(ABILITY_SLOTS).toEqual({ cooldownA: BODY.x, cooldownB: BODY.y, activeA: BODY.z, activeB: BODY.vx, shield: BODY.vy, held: BODY.vz });
  });

  it('accepts two abilities a runner takes', () => {
    const result = read(runner, { abilities: ['shoot', 'strike'] });
    expect(result.ok).toBe(true);
  });

  it('gives a spec without abilities the same spec hash and world hash as before', () => {
    const plain = read(runner);
    const empty = read(runner, { abilities: undefined });
    if (!plain.ok || !empty.ok) throw new Error('fixture must read');
    expect(gameSpecHash(empty.value)).toBe(gameSpecHash(plain.value));
    expect('abilities' in plain.value).toBe(false);
    const a = arcadeWorldOf(plain.value, 7);
    const b = arcadeWorldOf(empty.value, 7);
    if (!a.ok || !b.ok) throw new Error('fixture must compile');
    expect(hashArcade(instantiate(b.world))).toBe(hashArcade(instantiate(a.world)));
  });

  it.each([
    ['three abilities', runner, ['shoot', 'strike', 'dash'], /abilities/],
    ['an unknown ability', runner, ['fly'], /abilities/],
    ['the same ability twice', platform, ['dash', 'dash'], /listed twice/],
    ['an ability the control does not take', timing, ['shoot'], /does not take shoot/],
  ] as const)('rejects %s as MALFORMED_SPEC', (_name, fixture, abilities, issue) => {
    const result = read(fixture, { abilities });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MALFORMED_SPEC');
    expect(result.issues.join('\n')).toMatch(issue);
  });

  it('opens all five abilities on runner, platform and steer', () => {
    for (const fixture of [runner, platform, steer]) {
      const control = (fixture as { control: keyof typeof CAPABILITIES }).control;
      expect(CAPABILITIES[control].abilities).toEqual(ABILITIES);
    }
  });
});
