import { describe, expect, it } from 'vitest';
import sim from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { sealSimHash } from '../../ir/worlddoc';
import { buildRuntimeWorld } from '../../ir/build';
import { createEvidenceProject } from '../evidence-commit';
import { createSourceSnapshot, sealEvidenceDraft, EVIDENCE_VERSION } from '../evidence';
import { PARAMETER_KEYS, parameterProposalHash } from '../source-parameters';
import { createRuntimeController } from '../runtime-controller';
import { encodeSourceProject, decodeSourceProject, MAX_PROJECT_BYTES } from '../project-storage';

async function fixture(changed = false) {
  const made = await createSourceSnapshot({ sourceId: 'source', text: 'A scripted storage fixture.', title: 'Fixture',
    mediaType: 'text/plain', origin: 'own', rights: 'owned' });
  if (!made.ok) throw new Error('source');
  const source = made.value;
  const draft = await sealEvidenceDraft({ schemaVersion: EVIDENCE_VERSION, worldRevision: 'proposal', parentEvidenceHash: null,
    sources: [{ sourceId: 'source', sha256: source.sha256 }], interventions: [],
    claims: [{ claimId: 'fixture', text: 'Fixture only.', support: 'sourced', review: { status: 'unchecked' }, interventionId: null,
      spans: [{ sourceId: 'source', startByte: 0, endByte: source.text.length, excerpt: source.text }] }],
    bindings: Object.keys(sim.rules).map(id => ({ bindingId: `b.${id}`, target: { kind: 'rule', id }, claimIds: ['fixture'] })),
  }, { worldRevision: 'proposal', parent: null, sources: new Map([['source', source]]),
    ruleIds: new Set(Object.keys(sim.rules)), entityIds: new Set(Object.keys(sim.entities)) });
  if (!draft.ok) throw new Error('evidence');
  const world = sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim,
    look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
  const store = createEvidenceProject();
  const accepted = await store.commitInitial({ base: null, world, sources: [source], evidence: draft.value,
    parameterConfirmation: { version: 'source-parameters-v1', confirmed: [...PARAMETER_KEYS],
      proposalHash: await parameterProposalHash(sim, [source], draft.value) } });
  if (!accepted.ok) throw new Error(accepted.issues.join(','));
  const root = accepted.value;
  const built = buildRuntimeWorld(sim); if (!built.ok) throw new Error('sim');
  const runtime = createRuntimeController({ ...built.world, trace: oracle.cases[0].inputs });
  runtime.observeAt(300); runtime.setPaused(true);
  const runtimes = new Map([[root, runtime]]);
  let head = root;
  if (changed) {
    const result = await store.commitIntervention({ base: root.projectRevision, ruleId: 'start_countdown', durationTicks: 200,
      forkTick: 0, observationTick: 300, reason: 'Storage regression.' }, runtime);
    if (!result.ok) throw new Error(result.issues.join(','));
    head = result.value;
    const next = buildRuntimeWorld(head.world.sim); if (!next.ok) throw new Error('sim');
    const fork = runtime.forkAt(next.world, 0, 300); if (fork.verdict !== 'REBRANCHED') throw new Error('fork');
    runtimes.set(head, fork.controller);
  }
  return { root, head, runtimes, text: encodeSourceProject(head, root, runtimes, 'fixture') };
}

describe('local source project storage', () => {
  it.each([false, true])('validates and replays a saved project, branch=%s', async changed => {
    const saved = await fixture(changed);
    const restored = await decodeSourceProject(saved.text);
    expect(restored.head).toEqual(saved.head);
    expect(restored.selected).toEqual(saved.root);
    expect(restored.generation).toBe('fixture');
    expect(restored.runtimes.size).toBe(changed ? 2 : 1);
    for (const [project, runtime] of restored.runtimes) {
      const previous = [...saved.runtimes].find(([entry]) => entry.projectRevision === project.projectRevision)![1];
      expect(runtime.getSnapshot().values).toEqual(previous.getSnapshot().values);
      expect(runtime.getInputLog()).toEqual(previous.getInputLog());
      expect(runtime.getSnapshot().paused).toBe(true);
    }
  });
  it.each(['version', 'state', 'input', 'confirmation', 'branch', 'selection'])('rejects corrupted %s', async kind => {
    const saved = await fixture(true); const data = JSON.parse(saved.text);
    if (kind === 'version') data.version = 'future';
    if (kind === 'state') data.runtimes[0].values['f:alarm'] = 99;
    if (kind === 'input') data.runtimes[0].inputs[0].actionId = 'invented';
    if (kind === 'confirmation') data.head.parent.parameterConfirmation.confirmed.pop();
    if (kind === 'branch') data.head.comparison.durationTicks = 100;
    if (kind === 'selection') data.runtimes.pop();
    await expect(decodeSourceProject(JSON.stringify(data))).rejects.toThrow();
    expect(saved.runtimes.get(saved.root)!.getSnapshot().values['f:alarm']).toBe(0);
  });
  it('bounds decoding before parsing or replay', async () => {
    await expect(decodeSourceProject('x'.repeat(MAX_PROJECT_BYTES + 1))).rejects.toThrow('too large');
    await expect(decodeSourceProject('{bad')).rejects.toThrow();
  });
});
