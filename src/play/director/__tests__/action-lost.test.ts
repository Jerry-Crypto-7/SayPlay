import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/ir/worlddoc';
import { arcadeWorldOf } from '../../arcade/compile';
import { driveSpec } from '../../compose/drive';
import { actionEvidence, lostActions, missingActions } from '../../fidelity/action-evidence';
import type { GenreSpec } from '../../genre/contract';
import { essentialTriples, type Intent } from '../../intent/contract';
import { extractIntent } from '../../intent/extract';
import type { GameSpecV1 } from '../../spec';
import { actionIssues, critique } from '../critic';

const content: GenreSpec = { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city', cast: [{ label: 'zombie', does: 'shoot_at' }] };
const intent: Intent = {
  sentence: 'A car drives, races and shoots zombies.', hero: 'car', setting: 'city', negated: [], counts: [],
  items: [
    { axis: 'move', actor: 'car', verb: 'drive', object: null, essential: true, said: 'drives' },
    { axis: 'objective', actor: 'car', verb: 'race', object: null, essential: true, said: 'races' },
    { axis: 'action', actor: 'car', verb: 'shoot', object: 'zombie', essential: true, said: 'shoots' },
  ],
};
const specOf = (race: boolean, shoot: boolean): GameSpecV1 => driveSpec({ move: 'drive', objective: race ? 'race' : 'reach', actions: shoot ? ['shoot'] : [], threats: race ? ['rival'] : [] }, content);

describe('ACTION_LOST uses actual played actions', () => {
  it('rejects a same-car upgrade that loses both racing and shooting, while preserving driving', async () => {
    const beforeSpec = specOf(true, true), afterSpec = specOf(false, false);
    const before = await actionEvidence(beforeSpec, 1), after = await actionEvidence(afterSpec, 1);
    expect(missingActions(intent, before)).toEqual([]);
    expect(lostActions(intent, before, after)).toEqual([
      { actor: 'car', verb: 'race', object: null },
      { actor: 'car', verb: 'shoot', object: 'zombie' },
    ]);
    expect(after).toContainEqual(expect.objectContaining({ verb: 'drive', run: 'winner' }));
    const issues = actionIssues(afterSpec, intent, 1, after);
    expect(issues).toHaveLength(2);
    expect(issues.every(issue => issue.code === 'ACTION_LOST' && issue.severity === 'block')).toBe(true);
    expect(issues.map(issue => issue.evidence)).toEqual(expect.arrayContaining([expect.stringContaining('car race'), expect.stringContaining('car shoot zombie')]));
    expect(critique(afterSpec, intent, 1).filter(issue => issue.code === 'ACTION_LOST')).toEqual(issues);
  });

  it('does not block a genuine addition of shooting to an already racing car', async () => {
    const before = await actionEvidence(specOf(true, false), 2);
    const afterSpec = specOf(true, true), after = await actionEvidence(afterSpec, 2);
    expect(missingActions(intent, before)).toEqual([{ actor: 'car', verb: 'shoot', object: 'zombie' }]);
    expect(lostActions(intent, before, after)).toEqual([]);
    expect(actionIssues(afterSpec, intent, 2, after)).toEqual([]);
    expect(after).toContainEqual(expect.objectContaining({ verb: 'shoot', evidence: 'projectile-hit', run: 'winner', object: expect.objectContaining({ label: 'zombie' }) }));
  });

  it('swapping role identities on identical geometry changes which shooting triple is proved', async () => {
    const original = specOf(true, true);
    const barrier = original.roles.find(role => role.id === 'barrier')!.label;
    const swapped: GameSpecV1 = { ...original, roles: original.roles.map(role => role.id === 'enemy' ? { ...role, label: barrier } : role.id === 'barrier' ? { ...role, label: 'zombie' } : role) };
    const a = arcadeWorldOf(original, 3), b = arcadeWorldOf(swapped, 3);
    if (!a.ok || !b.ok) throw new Error('Drive specimens must compile');
    expect(canonicalHash(a.world)).toBe(canonicalHash(b.world));
    // A supplied published world still binds this version's actual identities.
    const before = await actionEvidence(original, 3, a.world), after = await actionEvidence(swapped, 3, b.world);
    expect(missingActions(intent, before)).toEqual([]);
    expect(lostActions(intent, before, after)).toEqual([{ actor: 'car', verb: 'shoot', object: 'zombie' }]);
    expect(after).toContainEqual(expect.objectContaining({ verb: 'shoot', object: expect.objectContaining({ label: barrier }) }));
    expect(actionIssues(swapped, intent, 3, after)).toEqual([expect.objectContaining({ code: 'ACTION_LOST', evidence: expect.stringContaining('shoot zombie') })]);
  });

  it('winning and scoring with a knitting label never prove an unknown knitting action', async () => {
    const knitting = extractIntent('A cat knits a scarf.');
    expect(essentialTriples(knitting)).toContainEqual({ actor: 'cat', verb: 'knit', object: 'scarf' });
    const raw = driveSpec({ move: 'drive', actions: ['shoot'], objective: 'reach', threats: [] }, { ...content, hero: 'cat' });
    const labelled: GameSpecV1 = { ...raw, title: 'Knit a scarf', objective: { ...raw.objective, description: 'Knit a scarf to win.' }, scoring: {},
      roles: raw.roles.map(role => role.id === 'finish' ? { ...role, label: 'scarf' } : role) };
    const witnesses = await actionEvidence(labelled, 1);
    expect(witnesses).toContainEqual(expect.objectContaining({ verb: 'drive', run: 'winner', actor: expect.objectContaining({ label: 'cat' }) }));
    expect(witnesses).toContainEqual(expect.objectContaining({ verb: 'score' }));
    expect(witnesses.some(witness => witness.verb === 'knit')).toBe(false);
    expect(missingActions(knitting, witnesses)).toContainEqual({ actor: 'cat', verb: 'knit', object: 'scarf' });
    expect(actionIssues(labelled, knitting, 1, witnesses)).toContainEqual(expect.objectContaining({ code: 'ACTION_LOST', severity: 'block', evidence: expect.stringContaining('cat knit scarf') }));
  });
});
