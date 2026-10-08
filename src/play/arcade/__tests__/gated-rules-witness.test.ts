import { beforeAll, describe, expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft';
import { arcadeWorldOf } from '../compile';
import { underlyingRule } from '../addons';
import { BODY, HEADER, bodyBase } from '../contract';
import { verifyArcade } from '../verify';
import { loadRapier } from '../physics/world';

// Složená hra (P42) balí nativní pravidla do `assembly_gate_*`; svědek musí
// sběr a interakci zapsat i pod obalem a nesmí za interakci považovat změnu
// stavu těla `assembly-state`, na kterou obal přepíná nativní výhru.
beforeAll(async () => { await loadRapier(); });

function composed(sentence: string) {
  const { spec } = draftGameSpecWithMeta(sentence);
  expect(spec.assemblyParts?.length ?? 0).toBeGreaterThan(0);
  const made = arcadeWorldOf({ ...spec, scoring: spec.scoring ?? {} }, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made;
}
const gatedIds = (made: ReturnType<typeof composed>) =>
  made.world.rules.filter((rule) => rule.id.startsWith('assembly_gate_')).map((rule) => underlyingRule(rule).id);
const keeperBodies = (made: ReturnType<typeof composed>) => {
  const kind = made.world.kinds.indexOf('assembly-state');
  return Array.from({ length: made.world.initial[HEADER.bodyCount]! }, (_, i) => i)
    .filter((i) => made.world.initial[bodyBase(i) + BODY.kind] === kind);
};

describe('the witness sees gated native rules', () => {
  it('a wrapped pickup still proves collecting', () => {
    const made = composed('a penguin slides down a glacier, hops over seals and catches fish');
    expect(gatedIds(made)).toContain('pickup');
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.witnesses.some((w) => w.verb === 'collect' && w.evidence.length > 0)).toBe(true);
  });

  // Ve složené hře je interakce díl, nativní pravidla (pickup, finish) jsou pod
  // obalem, a obal přepíná jejich výhru na stav keeperu.
  it('the interaction is proved on its target, never on the gate keeper', () => {
    const made = composed('a robot presses switches in a factory and escapes a guard dog');
    expect(gatedIds(made)).toEqual(expect.arrayContaining(['pickup', 'finish']));
    const keepers = keeperBodies(made);
    expect(keepers.length).toBeGreaterThan(0);
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const interacts = verdict.witnesses.filter((w) => w.verb === 'interact');
    expect(interacts.length).toBeGreaterThan(0);
    for (const witness of interacts) expect(keepers).not.toContain(witness.object?.body);
  });
});
