import { describe, expect, it } from 'vitest';
import { readPlannerEmission, buildIntentRequest } from '@/model/worldstream-intent';
import { auditForbidden, auditRelations, auditRequirements, scoreSemantics } from '../requirements';
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

/**
 * **Sémantické skóre nad orákulem (P22 T2) — pin na směr vztahu a zakázaný objekt.**
 *
 * Vztah přijatý bez ohledu na směr dá 100 % a nic neměří: „kočka pod stolem"
 * a „stůl pod kočkou" by byly totéž. Zakázaný objekt, který se přehlédne,
 * vypadá jako bohatší svět. Fixture: stůl se třemi hrnky a kočkou pod ním.
 */
describe('P22 semantic score: relations, forbidden objects and the combined score', () => {
  const sentence = 'A table with three cups on it and a cat under the table.';
  const cups = ['cup1', 'cup2', 'cup3'];
  function tableFixture(): SceneSpec {
    const groups = [
      { id: 'table', quote: 'A table', ids: ['table'], role: 'hero' as const },
      { id: 'cups', quote: 'three cups on it', ids: cups, role: 'prop' as const },
      { id: 'cat', quote: 'a cat under the table', ids: ['cat'], role: 'hero' as const },
    ];
    return {
      version: 1,
      requirements: groups.map((g) => ({ id: g.id, description: g.quote, priority: 'main' as const, polarity: 'required' as const, count: g.ids.length, instanceIds: g.ids, provenance: requested(g.quote) })),
      instances: groups.flatMap((g) => g.ids.map((stableId) => ({ stableId, requirementIds: [g.id], role: g.role, provenance: requested(g.quote), attributes: [], orientation: { description: 'upright', provenance: inferred } }))),
      relations: [
        ...cups.map((subjectId) => ({ subjectId, relation: 'on' as const, targetId: 'table', provenance: requested('three cups on it') })),
        { subjectId: 'table', relation: 'on', targetId: 'cat', provenance: requested('a cat under the table') },
      ],
      clarifications: [],
    };
  }
  const oracle = {
    required: [{ quote: 'table', count: 1 }, { quote: 'cups', count: 3 }, { quote: 'cat', count: 1 }],
    relations: [
      { subject: 'cups', relation: 'on' as const, object: 'table' },
      { subject: 'cat', relation: 'under' as const, object: 'table' },
    ],
  };

  it('accepts a satisfied relation and fails one whose direction is reversed', () => {
    const spec = tableFixture();
    expect(typeof readSceneSpec(spec, undefined, sentence)).not.toBe('string');
    expect(auditRelations(spec, [{ subject: 'cups', relation: 'on', object: 'table' }])).toEqual([]);
    expect(auditRelations(spec, [{ subject: 'cat', relation: 'under', object: 'table' }])).toEqual([]);
    expect(auditRelations(spec, [{ subject: 'table', relation: 'under', object: 'cat' }])).toEqual(['Missing relation: table under cat']);
    expect(auditRelations(spec, [{ subject: 'table', relation: 'on', object: 'cups' }])).toEqual(['Missing relation: table on cups']);
  });

  it('fails a forbidden object that is present and passes one that is absent', () => {
    const spec = tableFixture();
    expect(auditForbidden(spec, ['sofa'])).toEqual([]);
    expect(auditForbidden(spec, ['cat'])).toEqual(['Forbidden object present: cat']);
  });

  it('scores the fixture 1.0 and reports each component', () => {
    const score = scoreSemantics(tableFixture(), oracle);
    expect(score).toEqual({ presence: 1, counts: 1, relations: 1, forbidden: 1, score: 1, failures: [] });
  });

  it('scores an empty relations oracle as 1.0 for relations and a missing count as a counts failure', () => {
    const spec = tableFixture();
    spec.requirements[1].count = 2;
    spec.requirements[1].instanceIds = ['cup1', 'cup2'];
    spec.instances = spec.instances.filter((i) => i.stableId !== 'cup3');
    spec.relations = spec.relations.filter((r) => r.subjectId !== 'cup3');
    const score = scoreSemantics(spec, { required: oracle.required });
    expect(score.relations).toBe(1);
    expect(score.presence).toBe(1);
    expect(score.counts).toBeCloseTo(2 / 3);
    expect(score.failures).toEqual(['Expected 3 instances for: cups']);
    expect(score.score).toBeCloseTo((1 + 2 / 3 + 1 + 1) / 4);
  });

  it('lowers the score for a forbidden object and a reversed relation', () => {
    const spec = tableFixture();
    spec.relations[3] = { subjectId: 'cat', relation: 'on', targetId: 'table', provenance: requested('a cat under the table') };
    const score = scoreSemantics(spec, { ...oracle, forbidden: ['cat'] });
    expect(score.relations).toBe(0.5);
    expect(score.forbidden).toBe(0);
    expect(score.failures).toEqual(['Missing relation: cat under table', 'Forbidden object present: cat']);
  });
});
