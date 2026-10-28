/**
 * Audit scény P62 (T1) na třech ručně zadaných rychlých hrách. Audit, který náhradní model (kin, nearest, výchozí
 * robot) počítá jako „vlastní“, dá pěkné číslo a pošle výrobu modelů na špatná jména; interiér bez podlahy, který
 * audit nepozná, nechá T3 bez cíle.
 */

import { describe, expect, it } from 'vitest';

import type { GameSpecV1 } from '../../../../src/play/spec';
import { auditSpec, missingNouns, summarize } from '../audit.mjs';

/** Rychlá střelnice tak, jak ji dnes píše návrh ze slov; mění se jen místo a nepřítel. */
const shooter = (setting: string, foe: string): GameSpecV1 =>
  ({
    schema: 'gamespec.v1',
    control: 'shooter',
    controlParams: { waves: 6, rise: 4 },
    genre: { id: 'shooter', mode: 'default', compilerVersion: 'genre.v5' },
    title: 'Hand Written Range',
    archetype: 'combat_lite',
    targetDurationSec: 60,
    theme: { setting, mood: 'tense' },
    objective: { kind: 'defeat_targets', description: `Stop 6 waves of ${foe}s before they reach you.`, count: 6, role: 'enemy' },
    mechanics: [{ id: 'health', params: { max: 3 } }],
    roles: [
      { id: 'player', kind: 'player', label: 'cowboy', count: 1 },
      { id: 'target', kind: 'target', label: foe, count: 1 },
      { id: 'enemy', kind: 'hazard', label: foe, count: 1 },
    ],
    tutorial: { goalLine: 'Stop 6 waves.', controlsHint: 'Tap where you aim to shoot.' },
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
    budgets: { maxEntities: 40, maxRules: 120, maxTriangles: 200000 },
    scoring: {},
  }) as unknown as GameSpecV1;

const SEED = 62026;

describe('P62 scene audit', () => {
  it('a zombie in a desert town is the zombie’s own model, outdoors', () => {
    const row = auditSpec(shooter('desert town', 'zombie'), { seed: SEED, sentence: 'A cowboy shoots zombies in a desert town' });
    expect(row).toMatchObject({ genre: 'shooter.default', scene: 'shooter', look: 'desert', interior: false });
    expect(row.foe).toMatchObject({ label: 'zombie', noun: 'zombie', fromSentence: true, match: 'own' });
    expect(row.foe?.model).toMatch(/zombie/);
    expect(summarize([row]).foe).toMatchObject({ named: 1, own: 1, substitute: 0 });
  });

  it('a jackal drawn as the wolf (kin) is a substitute, never an own model', () => {
    const row = auditSpec(shooter('desert town', 'jackal'), { seed: SEED, sentence: 'A cowboy shoots jackals in a desert town' });
    expect(row.foe).toMatchObject({ label: 'jackal', noun: 'jackal', fromSentence: true, match: 'substitute', via: 'kin' });
    expect(row.foe?.model).toMatch(/wolf/);
    const summary = summarize([row]);
    expect(summary.foe).toMatchObject({ named: 1, own: 0, substitute: 1 });
    const missing = missingNouns([{ id: 'x1', ...row }], new Set());
    expect(missing.map((entry) => [entry.noun, entry.tier])).toEqual([['jackal', 'foe']]);
    // Slovo, které `not-nouns.txt` vylučuje, do seznamu nejde.
    expect(missingNouns([{ id: 'x1', ...row }], new Set(['jackal']))).toEqual([]);
    // Výchozí popisek žánru, který věta nejmenuje, není jméno z věty: do počtů ani do výroby nejde.
    const unnamed = auditSpec(shooter('desert town', 'jackal'), { seed: SEED, sentence: 'A cowboy defends a desert town' });
    expect(unnamed.foe).toMatchObject({ fromSentence: false, match: 'substitute' });
    expect(summarize([unnamed]).foe).toMatchObject({ named: 0, substitute: 0, genreDefault: 1 });
    expect(missingNouns([{ id: 'x2', ...unnamed }], new Set())).toEqual([]);
  });

  it('a shooting range in a shopping mall is an interior without floor or walls, its scenery stands in the aiming cone', () => {
    const row = auditSpec(shooter('shopping mall', 'zombie'), { seed: SEED, sentence: 'zombie shooter in a shopping mall' });
    expect(row).toMatchObject({ look: 'mall', interior: true, floor: { kind: 'plain', indoor: false }, walls: false });
    const scenery = row.scenery;
    expect(scenery).not.toBeNull();
    expect((scenery?.inside ?? 0) + (scenery?.edge ?? 0)).toBe(scenery?.rows);
    expect(scenery?.inside).toBeGreaterThan(0);
    expect(summarize([row])).toMatchObject({ interiors: 1, interiorsWithoutFloor: 1, interiorsWithoutWalls: 1 });
  });
});
