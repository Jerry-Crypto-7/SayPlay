/**
 * Čipy remixu (P23-C T3): každý čip na každém archetypu dá spec, který
 * `readGameSpec` vezme a který se od rodiče liší; týž vstup dá týž výstup.
 * Čip, který by na některé fixtuře vrátil rodiče beze změny, by na stránce
 * vypadal jako remix a nebyl by – proto se různost drží tady.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ARCHETYPE_IDS } from '../registry';
import { applyChip, CHIPS } from '../remix';
import { gameSpecHash, readGameSpec, type GameSpecV1 } from '../spec';

function fixture(archetype: string): GameSpecV1 {
  const read = readGameSpec(JSON.parse(readFileSync(`src/play/__fixtures__/${archetype}.json`, 'utf8')));
  if (!read.ok) throw new Error(`fixture ${archetype}: ${read.issues.join('; ')}`);
  return read.value;
}

describe('applyChip', () => {
  it.each(ARCHETYPE_IDS)('%s: každý čip dá validní a jiný spec, deterministicky', (archetype) => {
    const parent = fixture(archetype);
    for (const chip of CHIPS) {
      const child = applyChip(parent, chip, 11);
      const read = readGameSpec(child);
      expect(read.ok, `${archetype}/${chip}: ${read.ok ? '' : read.issues.join('; ')}`).toBe(true);
      expect(gameSpecHash(child)).not.toBe(gameSpecHash(parent));
      expect(gameSpecHash(applyChip(parent, chip, 11))).toBe(gameSpecHash(child));
      expect(child.title.length).toBeLessThanOrEqual(80);
    }
  });

  it('harder zpřísní to, co hra má: pronásledovatele, čas nebo počet', () => {
    const chase = applyChip(fixture('chase_escape'), 'harder', 1);
    expect(chase.mechanics.find((m) => m.id === 'chaser')?.params.speed).toBe('fast');
    const survive = applyChip(fixture('survival_timer'), 'harder', 1);
    const timer = survive.mechanics.find((m) => m.id === 'timer')!;
    expect(timer.params.seconds).toBe(survive.objective.seconds);
    expect(timer.params.seconds).toBeLessThan(fixture('survival_timer').objective.seconds!);
  });

  it('swap_enemy bez nepřítele spadne na harder; s nepřítelem mění jen jeho label', () => {
    const parent = fixture('chase_escape');
    const child = applyChip(parent, 'swap_enemy', 3);
    const enemy = parent.roles.find((role) => role.kind === 'chaser')!;
    const swapped = child.roles.find((role) => role.id === enemy.id)!;
    expect(swapped.label).not.toBe(enemy.label);
    expect(child.roles.filter((role) => role.id !== enemy.id)).toEqual(parent.roles.filter((role) => role.id !== enemy.id));
    expect(applyChip(fixture('collect_exit'), 'swap_enemy', 3).title).toMatch(/harder$/);
  });

  it('reskin mění jen theme a title', () => {
    const parent = fixture('switch_puzzle');
    const child = applyChip(parent, 'reskin', 5);
    expect(child.theme).not.toEqual(parent.theme);
    const { theme: _t, title: _i, ...rest } = child;
    const { theme: _pt, title: _pi, ...parentRest } = parent;
    expect(rest).toEqual(parentRest);
  });
});
