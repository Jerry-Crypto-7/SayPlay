import { describe, expect, it, vi } from 'vitest';
import surface from '../../../evals/reality-compiler/museum.sim.json';
import oracle from '../../../evals/reality-compiler/oracle.json';
import { buildRuntimeWorld } from '../../ir/build';
import { canonical, sealSimHash } from '../../ir/worlddoc';
import { createEvidenceProject, projectWorldRevision } from '../evidence-commit';
import { createSourceSnapshot, evidenceDigest, sealEvidenceDraft, EVIDENCE_VERSION } from '../evidence';
import { createRuntimeController } from '../runtime-controller';
import { openSession, clearSessions, commitSessionProject, getSessionProject, commitSessionIntervention } from '../sessions';

async function fixture() {
  const world = sealSimHash({ irVersion: 'v1', simRevision: 7, lookRevision: 3, sim: structuredClone(surface),
    look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } });
  const made = await createSourceSnapshot({ sourceId: 'procedure', text: '\ufeffČasovač: 20 sekund.\r\n',
    title: 'Museum', mediaType: 'text/plain', origin: 'own', rights: 'owned' });
  if (!made.ok) throw new Error('source');
  const source = made.value;
  const evidence = await sealEvidenceDraft({ schemaVersion: EVIDENCE_VERSION, worldRevision: 't7-proposal',
    parentEvidenceHash: null, sources: [{ sourceId: source.sourceId, sha256: source.sha256 }],
    claims: [{ claimId: 'duration', text: 'Timer: 20 seconds.', support: 'sourced', interventionId: null,
      review: { status: 'unchecked' }, spans: [{ sourceId: source.sourceId, startByte: 0,
        endByte: Buffer.byteLength(source.text), excerpt: source.text }] }],
    bindings: Object.keys(surface.rules).map((id, i) => ({ bindingId: `binding_${i}`,
      target: { kind: 'rule', id }, claimIds: ['duration'] })), interventions: [],
  }, { worldRevision: 't7-proposal', parent: null, sources: new Map([[source.sourceId, source]]),
    ruleIds: new Set(Object.keys(surface.rules)), entityIds: new Set(Object.keys(surface.entities)) });
  if (!evidence.ok) throw new Error(evidence.issues.join(','));
  const input = structuredClone({ base: null, world, evidence: evidence.value, sources: [source] });
  const built = buildRuntimeWorld(world.sim);
  if (!built.ok) throw new Error('world');
  const runtime = createRuntimeController({ ...built.world, trace: oracle.cases[0].inputs });
  runtime.observeAt(300);
  const store = createEvidenceProject();
  const request = () => ({ base: store.getSnapshot()!.projectRevision, ruleId: 'start_countdown',
    durationTicks: 200, forkTick: 0, observationTick: 300, reason: 'Try ten seconds.' });
  return { input, runtime, store, request };
}

describe('atomic evidence project revision', () => {
  it('accepts a complete world and seals the T7 proposal to its actual revision', async () => {
    const { input, store } = await fixture();
    const result = await store.commitInitial(input);
    expect(result.ok).toBe(true);
    const accepted = store.getSnapshot()!;
    expect(accepted.world).toEqual(input.world);
    expect(accepted.evidence.worldRevision).toBe(projectWorldRevision(input.world));
    expect(accepted.evidence.evidenceHash).not.toBe(input.evidence.evidenceHash);
    expect(accepted.sources).toEqual(input.sources);
    expect(accepted).toMatchObject({ branchId: 'origin', parent: null, comparison: null });
  });

  it('commits 400→200, its evidence and the independent oracle result together', async () => {
    const { input, store, runtime, request } = await fixture();
    await store.commitInitial(input);
    const original = store.getSnapshot()!;
    const live = runtime.getSnapshot();
    expect((await store.commitIntervention(request(), runtime)).ok).toBe(true);
    const next = store.getSnapshot()!;
    expect(next.parent).toBe(original);
    expect(next.sources).toBe(original.sources);
    expect(Buffer.from(next.sources[0].text)).toEqual(Buffer.from(input.sources[0].text));
    expect(next.evidence.parentEvidenceHash).toBe(original.evidence.evidenceHash);
    expect(next.evidence.interventions).toEqual([expect.objectContaining({ ruleId: 'start_countdown',
      before: 400, after: 200, baseWorldRevision: original.evidence.worldRevision, parentBranchId: 'origin' })]);
    const changed = next.evidence.claims.find(claim => claim.interventionId !== null)!;
    expect(changed).toMatchObject({ support: 'assumed', review: { status: 'unchecked' } });
    expect(next.evidence.bindings.find(binding => binding.target.id === 'start_countdown')!.claimIds).toEqual([changed.claimId]);
    expect(original.evidence.claims).toEqual(input.evidence.claims);
    expect(next.comparison!.original.values).toMatchObject({ 'e:case:locked': 0, 'f:alarm': 0 });
    expect(next.comparison!.changed.values).toMatchObject({ 'e:case:locked': 1, 'f:alarm': 1 });
    expect(runtime.getSnapshot()).toBe(live);
    expect(next.world.simRevision).toBe(8);
    expect(next.world.look).toEqual(original.world.look);
  });

  it.each(['hash', 'world', 'look', 'source', 'extra-source', 'missing-source', 'binding', 'review', 'evidence-hash', 'span', 'parent'])(
    'rejects invalid %s without accepting either half', async kind => {
      const { input, store } = await fixture();
      if (kind === 'hash') input.world.simHash = 'forged';
      if (kind === 'world') (input.world.sim.rules.start_countdown.actions[1] as { ref: string }).ref = 'missing';
      if (kind === 'look') Object.assign(input.world.look.palette, { broken: Infinity });
      if (kind === 'source') Object.assign(input.sources[0], { text: input.sources[0].text + 'x' });
      if (kind === 'extra-source') input.sources.push({ ...input.sources[0], sourceId: 'extra' });
      if (kind === 'missing-source') input.sources = [];
      if (kind === 'binding') input.evidence.bindings[0].target.id = 'missing';
      if (kind === 'review') Object.assign(input.evidence.claims[0].review, { status: 'confirmed',
        reviewerId: 'human', at: '2026-09-08T12:00:00Z', scope: 'textual-support' });
      if (kind === 'span') {
        const claim = input.evidence.claims[0];
        if (claim.support === 'sourced') claim.spans[0].startByte = 1;
      }
      if (kind === 'parent') input.evidence.parentEvidenceHash = 'a'.repeat(64);
      if (kind === 'evidence-hash') input.evidence.evidenceHash = '0'.repeat(64);
      else {
        const { evidenceHash: _hash, ...draft } = input.evidence;
        input.evidence.evidenceHash = await evidenceDigest(draft);
      }
      if (kind === 'world') input.world = sealSimHash(input.world);
      expect((await store.commitInitial(input)).ok).toBe(false);
      expect(store.getSnapshot()).toBeNull();
    });

  it.each([
    { base: 'stale' }, { ruleId: 'missing' }, { durationTicks: 400 }, { durationTicks: 401 },
    { durationTicks: 1.5 }, { forkTick: 21 }, { forkTick: 301 }, { before: 999 }, { reason: '' },
  ])('preserves the accepted pair on intervention failure %#', async overrides => {
    const { input, store, runtime, request } = await fixture();
    await store.commitInitial(input);
    const before = store.getSnapshot();
    const live = runtime.getSnapshot();
    expect((await store.commitIntervention({ ...request(), ...overrides }, runtime)).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(runtime.getSnapshot()).toBe(live);
  });

  it('publishes one winner for competing initial commits and competing interventions', async () => {
    const { input, store, runtime, request } = await fixture();
    const initial = await Promise.all([store.commitInitial(input), store.commitInitial(input)]);
    expect(initial.filter(result => result.ok)).toHaveLength(1);
    expect(initial.find(result => !result.ok)).toEqual({ ok: false, issues: ['STALE_REVISION'] });
    const edits = await Promise.all([store.commitIntervention(request(), runtime),
      store.commitIntervention({ ...request(), durationTicks: 100 }, runtime)]);
    expect(edits.filter(result => result.ok)).toHaveLength(1);
    expect(edits.find(result => !result.ok)).toEqual({ ok: false, issues: ['STALE_REVISION'] });
    const accepted = store.getSnapshot();
    expect((await store.commitIntervention(request(), runtime)).ok).toBe(false);
    expect(store.getSnapshot()).toBe(accepted);
  });

  it('rejects inputs arriving during asynchronous evidence validation', async () => {
    const { input, store, runtime, request } = await fixture();
    await store.commitInitial(input);
    const before = store.getSnapshot();
    const pending = store.commitIntervention(request(), runtime);
    runtime.dispatch({ actor: 'visitor', actionId: 'activate', target: 'sensorA' });
    expect(await pending).toEqual({ ok: false, issues: ['STALE_INPUTS'] });
    expect(store.getSnapshot()).toBe(before);
  });

  it('isolates caller mutations during awaits and freezes every accepted component', async () => {
    const { input, store } = await fixture();
    const expected = structuredClone(input);
    const pending = store.commitInitial(input);
    input.world.simRevision = 99;
    Object.assign(input.sources[0], { text: 'changed' });
    input.evidence.claims[0].text = 'changed';
    expect((await pending).ok).toBe(true);
    const accepted = store.getSnapshot()!;
    expect(accepted.world).toEqual(expected.world);
    expect(accepted.sources).toEqual(expected.sources);
    const before = canonical(accepted);
    expect(() => { accepted.evidence.claims[0].text = 'overwrite'; }).toThrow();
    expect(() => { accepted.world.simRevision = 99; }).toThrow();
    expect(canonical(store.getSnapshot())).toBe(before);
  });

  it('leaves the parent usable if hashing fails after branch comparison', async () => {
    const { input, store, runtime, request } = await fixture();
    await store.commitInitial(input);
    const before = store.getSnapshot();
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('hash failed'));
    try {
      expect(await store.commitIntervention(request(), runtime)).toEqual({ ok: false, issues: ['PROJECT_VALIDATION_FAILED'] });
      expect(store.getSnapshot()).toBe(before);
    } finally { spy.mockRestore(); }
    expect((await store.commitIntervention(request(), runtime)).ok).toBe(true);
  });

  it('stores and reads the complete revision through the session adapter', async () => {
    clearSessions();
    const stored = openSession('evidence-test', 17)!;
    const other = openSession('other', 18)!;
    const { input, runtime } = await fixture();
    const legacy = { blueprint: stored.blueprint, changes: [...stored.changes],
      sharedWorld: stored.sharedWorld, session: stored.session.snapshot() };
    expect((await commitSessionProject(stored, input)).ok).toBe(true);
    const base = getSessionProject(stored)!;
    expect(getSessionProject(other)).toBeNull();
    expect((await commitSessionIntervention(stored, { base: base.projectRevision, ruleId: 'start_countdown',
      durationTicks: 200, forkTick: 0, observationTick: 300, reason: 'Experiment' }, runtime)).ok).toBe(true);
    expect(getSessionProject(stored)!.parent).toBe(base);
    expect(getSessionProject(stored)!.world.simRevision).toBe(8);
    expect({ blueprint: stored.blueprint, changes: [...stored.changes],
      sharedWorld: stored.sharedWorld, session: stored.session.snapshot() }).toEqual(legacy);
    clearSessions();
  });
});
