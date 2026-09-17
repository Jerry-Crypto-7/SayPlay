import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANSWER, PLAN, grammar } from '@/app/api/worldstream/__tests__/world-fixture';
import { compileBlueprint } from '@/model/worldstream-compiler';
import { compileWithRepair } from '@/model/worldstream-repair';
import { clearSessions, openSession, runGeneration } from '../sessions';
import { initialClientState, reduceEvent, applySnapshot, type ClientState } from '../reducer';
import { visualPreviewSchema } from '../schema';
import { buildVisualPreviewFrom } from '../proxy';
import { GET } from '@/app/api/worldstream/sessions/[sessionId]/route';
import type { SessionEvent } from '../events';
import type { SceneSpec } from '@/scene/spec';

afterEach(clearSessions);
const upstream = { model: 'fixture', system: 'fixture', user: 'fixture' };
const failed = () => {
  const answer = structuredClone(ANSWER) as any;
  answer.world.sim.rules = {}; answer.world.sim.witness = [];
  answer.placements[1].binding = { collider: answer.placements[1].targetBounds, sockets: [], parts: [], entityId: 'unverified-actor', signalFlag: 'unverified-flag' };
  return answer;
};
function preview() {
  const result = compileBlueprint(failed(), PLAN, { sessionSeed: 4021, upstream });
  expect(result).toMatchObject({ ok: false, reason: 'WORLD_REJECTED' });
  if (result.ok || !result.preview) throw new Error('Expected separately validated preview'); return result.preview;
}
const feed = (state: ClientState, event: SessionEvent) => {
  const next = reduceEvent(state, event); if (!next.ok) throw new Error(next.fault); return next.state;
};

describe('noninteractive own visual preview after rejected logic', () => {
  it('keeps validated visuals without a simulation, revision, hash or behavioral binding', async () => {
    const value = preview();
    expect(value).toMatchObject({ kind: 'visual-preview', interactive: false, validation: { layout: 'not-requested' } });
    for (const key of ['world', 'sim', 'simHash', 'simRevision', 'lookRevision']) expect(value).not.toHaveProperty(key);
    expect(value.objects[1].binding).not.toHaveProperty('entityId'); expect(value.objects[1].binding).not.toHaveProperty('signalFlag');
    expect(visualPreviewSchema.safeParse({ ...value, world: ANSWER.world }).success).toBe(false);
    const mesh = vi.fn(); const built = await buildVisualPreviewFrom(value, { mesh, deferMeshes: true });
    expect(built).toMatchObject({ kind: 'built', interactive: false }); expect(mesh).not.toHaveBeenCalled();
    expect(built).not.toHaveProperty('world'); expect(built).not.toHaveProperty('runtime');
  });

  it.each(['malformed', 'geometry', 'asset', 'look', 'reference'])('never preserves an invalid %s preview', kind => {
    const answer = failed();
    if (kind === 'geometry') answer.geometry = { nodes: [], root: 0 };
    if (kind === 'asset') answer.placements[1].source = { kind: 'asset', assetId: 'unknown-fixture', version: 1, hash: 'a'.repeat(64) };
    if (kind === 'look') answer.world.look = null;
    if (kind === 'reference') answer.placements[1].source = { kind: 'shape', shapeId: 'missing-shape' };
    const result = compileBlueprint(kind === 'malformed' ? 'a scene' : answer, PLAN, { sessionSeed: 4021, upstream });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('preview');
  });

  it('checks declared layout relations before making a visual claim', () => {
    const provenance = { kind: 'inferred' as const, reason: 'fixture layout relation' };
    const spec: SceneSpec = { version: 1, clarifications: [],
      requirements: PLAN.objects.map(o => ({ id: `r-${o.stableId}`, description: o.label, priority: 'main', polarity: 'required', count: 1, instanceIds: [o.stableId], provenance })),
      instances: PLAN.objects.map(o => ({ stableId: o.stableId, requirementIds: [`r-${o.stableId}`], role: o.role, provenance, attributes: [], orientation: { description: 'upright', provenance } })),
      relations: [{ subjectId: 'ironMast', relation: 'inside', targetId: 'saltFlat', provenance }] };
    const bad = compileBlueprint(failed(), { ...PLAN, sceneSpec: spec }, { sessionSeed: 4021, upstream });
    expect(bad).not.toHaveProperty('preview');
    spec.relations[0].relation = 'near';
    const valid = compileBlueprint(failed(), { ...PLAN, sceneSpec: spec }, { sessionSeed: 4021, upstream });
    expect(valid).toMatchObject({ ok: false, preview: { validation: { layout: 'checked' } } });
  });

  it('publishes between repair attempts while keeping the rejected compiler outcome', async () => {
    const observe = vi.fn(); const answer = failed(); let calls = 0;
    const result = await compileWithRepair({ plan: PLAN, grammar: grammar(), sessionSeed: 4021, maxRounds: 2,
      onVisualPreview: observe, emit: async () => { calls++; if (calls === 2) expect(observe).toHaveBeenCalledOnce(); return answer; } });
    expect(result.kind).toBe('rejected'); expect(observe).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('serves preview in the real session stream and reconnect; eventual success=%s', async success => {
    const stored = openSession('preview-session', 4021)!; let call = 0;
    await runGeneration(stored, PLAN.intent.setting, { legacyPlan: true, grammar: grammar(),
      emit: async () => { call++; return call === 1 ? PLAN : call === 2 ? failed() : success ? ANSWER : { geometry: 'invalid' }; } });
    const events = stored.session.events.all();
    expect(events.some(e => e.type === 'visual.preview')).toBe(true);
    let state = initialClientState(); for (const event of events) state = feed(state, event);
    const reply = await GET(new Request('http://localhost'), { params: Promise.resolve({ sessionId: stored.session.sessionId }) });
    const payload = await reply.json();
    const reconnected = applySnapshot(initialClientState(), payload);
    if (success) {
      expect(state.visualPreview).toBeNull(); expect(reconnected.visualPreview).toBeNull(); expect(payload.visualPreview).toBeNull();
      expect(state.phase).toBe('world'); expect(stored.blueprint).not.toBeNull();
    } else {
      expect(state.phase).toBe('failed'); expect(state.visualPreview).toMatchObject({ interactive: false });
      expect(reconnected.visualPreview).toEqual(state.visualPreview); expect(stored.blueprint).toBeNull();
      expect(stored.sharedWorld).toBeNull(); expect(stored.session.representations).toEqual([]);
      expect(events.some(e => ['blueprint.ready', 'world.ready'].includes(e.type))).toBe(false);
    }
    const old = events.find(e => e.type === 'visual.preview')!;
    expect(reduceEvent({ ...initialClientState(), sessionId: 'new-session' }, old)).toMatchObject({ ok: false, fault: 'FOREIGN_SESSION' });
    expect(feed({ ...state, sequence: old.sequence - 1 }, { ...old, payload: { preview: { invalid: true } } }).visualPreview).toEqual(state.visualPreview);
  });
});
