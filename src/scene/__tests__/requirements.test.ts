import { describe, expect, it } from 'vitest';
import { readPlannerEmission, buildIntentRequest } from '@/model/worldstream-intent';
import { auditRequirements } from '../requirements';
import { readSceneSpec, type SceneSpec } from '../spec';

const prompt = 'Čítárna s pěti posluchači u akvária. Posluchači hledí na akvárium. Bez stolů. Jeden modrý chronokvět je uvnitř akvária.';
const inferred = { kind: 'inferred', reason: 'Průchozí prostor a přirozený směr pohledu.' } as const;
const requested = (quote: string) => ({ kind: 'requested' as const, quote });
function fixture(): SceneSpec {
  const listeners = Array.from({ length: 5 }, (_, n) => `listener${n + 1}`);
  const groups = [
    { id: 'reading', quote: 'Čítárna', ids: ['room'], role: 'architecture' as const },
    { id: 'listeners', quote: 'pěti posluchači', ids: listeners, role: 'hero' as const },
    { id: 'aquarium', quote: 'akvária', ids: ['aquarium'], role: 'hero' as const },
    { id: 'flower', quote: 'Jeden modrý chronokvět', ids: ['chronoflower'], role: 'prop' as const },
  ];
  return {
    version: 1,
    requirements: [
      ...groups.map((g) => ({ id: g.id, description: g.quote, priority: 'main' as const, polarity: 'required' as const, count: g.ids.length, instanceIds: g.ids, provenance: requested(g.quote) })),
      { id: 'noTables', description: 'Žádné stoly', priority: 'secondary', polarity: 'forbidden', count: 0, instanceIds: [], provenance: requested('Bez stolů') },
    ],
    instances: groups.flatMap((g) => g.ids.map((stableId) => ({ stableId, requirementIds: [g.id], role: g.role, provenance: requested(g.quote), attributes: stableId === 'chronoflower' ? [{ name: 'colour', value: 'blue', provenance: requested('modrý') }] : [], orientation: { description: 'Přirozené vzpřímené umístění', provenance: inferred } }))),
    relations: [
      ...listeners.map((subjectId) => ({ subjectId, relation: 'facing' as const, targetId: 'aquarium', provenance: requested('Posluchači hledí na akvárium') })),
      { subjectId: 'chronoflower', relation: 'inside', targetId: 'aquarium', provenance: requested('uvnitř akvária') },
    ],
    clarifications: [],
  };
}
function plan(spec = fixture()) {
  return {
    intent: { setting: 'Čítárna', mood: 'Klidná', spatialThesis: 'Posluchači hledí na akvárium.', actors: ['posluchači'], heroObjects: ['akvárium'], interactions: [], unsupported: [] },
    objects: spec.instances.map((i) => ({ stableId: i.stableId, label: i.stableId, synonyms: [i.stableId], role: i.role, importance: 2 })),
    sceneSpec: spec,
  };
}

describe('P20 semantic requirements: manually authored prompt expectations', () => {
  it('keeps five separate listeners, a repeated reference, a negation and a novel object', () => {
    const result = readPlannerEmission(plan(), { requireSceneSpec: true, prompt });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(auditRequirements(result.value.sceneSpec!, [
      { quote: 'pěti posluchači', count: 5, polarity: 'required' },
      { quote: 'Bez stolů', count: 0, polarity: 'forbidden' },
      { quote: 'Jeden modrý chronokvět', count: 1, polarity: 'required', attributes: [{ name: 'colour', value: 'blue' }] },
    ])).toEqual([]);
    expect(result.value.sceneSpec!.relations.filter((r) => r.relation === 'facing')).toHaveLength(5);
    expect(result.value.sceneSpec!.instances).toHaveLength(8);
  });
  it('independent count oracle rejects a coherent but incorrect one-listener plan', () => {
    const spec = fixture();
    spec.instances = spec.instances.filter((i) => !/^listener[2-5]$/.test(i.stableId));
    spec.relations = spec.relations.filter((i) => !/^listener[2-5]$/.test(i.subjectId));
    spec.requirements[1].count = 1;
    spec.requirements[1].instanceIds = ['listener1'];
    expect(typeof readSceneSpec(spec)).not.toBe('string');
    expect(auditRequirements(spec, [{ quote: 'pěti posluchači', count: 5, polarity: 'required' }])).toEqual(['Expected 5 instances for: pěti posluchači']);
  });
  it.each([
    ['duplicate identity', (s: SceneSpec) => { s.instances[1].stableId = s.instances[0].stableId; }],
    ['count collapse', (s: SceneSpec) => { s.requirements[1].instanceIds = ['listener1']; }],
    ['missing target', (s: SceneSpec) => { s.relations[0].targetId = 'missing'; }],
    ['broken reciprocal reference', (s: SceneSpec) => { s.instances[1].requirementIds = ['reading']; }],
    ['negation violated', (s: SceneSpec) => { s.requirements[4].count = 1; }],
    ['false provenance', (s: SceneSpec) => { s.instances[1].provenance = requested('červená pohovka'); }],
    ['duplicate relation', (s: SceneSpec) => { s.relations.push(s.relations[0]); }],
  ])('rejects %s', (_name, mutate) => {
    const spec = fixture(); mutate(spec);
    expect(typeof readSceneSpec(spec, undefined, prompt)).toBe('string');
  });
  it('strict new plans reject legacy data while replay remains readable without invented evidence', () => {
    const { sceneSpec: _spec, ...legacy } = plan();
    expect(readPlannerEmission(legacy, { requireSceneSpec: true }).ok).toBe(false);
    const replay = readPlannerEmission(legacy, { requireSceneSpec: false });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.sceneSpec).toBeUndefined();
  });
  it('rejects objects not represented in the semantic ledger and conflicting roles', () => {
    const missing = plan(); missing.objects.pop();
    expect(readPlannerEmission(missing).ok).toBe(false);
    const role = plan(); role.objects[0].role = 'effect';
    expect(readPlannerEmission(role).ok).toBe(false);
  });
  it('records a result-changing ambiguous relation and its declared assumption', () => {
    const spec = fixture();
    spec.clarifications = [{ question: 'Má být chronokvět u posluchače, nebo uvnitř akvária?', affects: 'appearance', assumption: 'Použito explicitní uvnitř akvária.' }];
    expect(readSceneSpec(spec)).toEqual(spec);
    expect(buildIntentRequest(prompt).system).toContain('Only a result-changing ambiguity');
  });
});
