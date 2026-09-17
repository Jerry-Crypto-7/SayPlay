import { describe, expect, it } from 'vitest';
import { asset } from '@/assets/__fixtures__/catalog';
import { createAssetManifest } from '@/assets/manifest';
import { sealSimHash } from '@/ir/worlddoc';
import { repairEmission } from '@/model/repair';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import { blueprintSchema, type WorldstreamBlueprint } from '../schema';
import { findBlueprintReferenceIssues } from '../references';
import { createSession, restoreSession } from '../session';
import { buildProxyWorldFrom } from '../proxy';
import { slotFromAsset, toWorld } from '../slots';
import { bindRuntime } from '../runtime-controller';

const first = asset();
const second = { ...asset(), version: 2, hash: 'b'.repeat(64),
  lods: [{ ...first.lods[0], hash: 'b'.repeat(64) }] };
const manifest = createAssetManifest({ version: 'worldstream-assets-v1', assets: [first, second] });
const reference = (version = 1) => ({ kind: 'asset' as const, assetId: first.assetId, version,
  hash: version === 1 ? first.hash : second.hash });
function blueprint(): WorldstreamBlueprint {
  return blueprintSchema.parse({ version: 'worldstream-v2', sessionSeed: 4021, title: 'An asset world',
    intent: EXAMPLE_PLAN.intent,
    world: sealSimHash(repairEmission(EXAMPLE_BLUEPRINT_ANSWER.world).document as { sim: unknown }),
    geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [],
    objects: [{ stableId: 'hiveVisual', label: 'Hive', synonyms: [], role: 'hero', importance: 3,
      source: reference(), targetBounds: { min: [-2, 0, -2], max: [2, 2, 2] },
      binding: { entityId: 'tallHive', collider: { min: [-1, 0, -1], max: [1, 2, 1] },
        sockets: [{ id: 'seat', at: [0, 0.7, 0], normal: [0, 1, 0] }],
        parts: [{ id: 'body', sockets: ['seat'] }] } }],
  });
}

describe('versioned object / representation contract', () => {
  it('roundtrips v2 and legacy v1 without silently upgrading or accepting v2 fields in v1', () => {
    const v2 = blueprint();
    expect(blueprintSchema.parse(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
    expect(blueprintSchema.safeParse({ ...v2, version: 'worldstream-v1' }).success).toBe(false);
    const object = { ...v2.objects[0], source: { kind: 'geom', node: 0 }, binding: undefined };
    const v1 = blueprintSchema.parse({ ...v2, version: 'worldstream-v1', objects: [object] });
    expect(blueprintSchema.parse(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
  });

  it('rejects missing/stale catalog references, duplicate IDs and missing entity/part/socket bindings', () => {
    expect(findBlueprintReferenceIssues(blueprint(), manifest)).toEqual([]);
    expect(findBlueprintReferenceIssues(blueprint()).length).toBeGreaterThan(0);
    for (const mutate of [
      (b: WorldstreamBlueprint) => { b.objects.push(structuredClone(b.objects[0])); },
      (b: WorldstreamBlueprint) => { b.objects[0].source = reference(3); },
      (b: WorldstreamBlueprint) => { b.objects[0].source = { ...reference(), hash: 'c'.repeat(64) }; },
      (b: WorldstreamBlueprint) => { b.objects[0].binding!.entityId = 'missing'; },
      (b: WorldstreamBlueprint) => { b.objects[0].binding!.parts[0].id = 'missing'; },
      (b: WorldstreamBlueprint) => { b.objects[0].binding!.sockets[0].id = 'missing'; },
    ]) {
      const b = blueprint(); mutate(b);
      expect(findBlueprintReferenceIssues(b, manifest).length).toBeGreaterThan(0);
    }
  });

  it('replaces an asset revision without changing simHash, state, collider, entity or socket', () => {
    const b = blueprint(); const before = structuredClone(b);
    const runtime = bindRuntime(null, 'assets', b.world);
    runtime.controller.advanceTicks(10);
    const runningState = runtime.controller.getSnapshot();
    const session = createSession({ sessionId: 'assets', sessionSeed: b.sessionSeed });
    session.registerBlueprint(b, manifest);
    const next = { ...b.objects[0], source: reference(2) };
    const slot = slotFromAsset(b.objects[0], first);
    expect(session.replaceAsset(next.stableId, 0, next, manifest)).toEqual({ ok: true, revision: 1 });
    expect(b).toEqual(before);
    expect(b.world.simHash).toEqual(before.world.simHash);
    const rebound = bindRuntime(runtime, 'assets', { ...b.world });
    expect(rebound).toBe(runtime);
    expect(rebound.controller.getSnapshot()).toBe(runningState);
    expect(session.representations[0].object?.binding).toEqual(before.objects[0].binding);
    expect(slotFromAsset(next, second)).toEqual({ ...slot, source: reference(2) });
    expect(toWorld(slot.transform, slot.anchors[0].at)).toEqual([0, 0.7, 0]);
    expect(session.replaceAsset(next.stableId, 0, next, manifest)).toEqual({ ok: false, reason: 'STALE_REVISION' });
    expect(session.apply({ sessionId: 'assets', stableId: next.stableId, representationRevision: 0,
      next: { kind: 'validating' } })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    const restored = restoreSession(JSON.parse(JSON.stringify(session.snapshot())));
    expect(restored.representations).toEqual(session.representations);
    const exposed = restored.representations[0].object!; exposed.binding!.sockets[0].at[0] = 99;
    expect(restored.representations[0].object?.binding).toEqual(next.binding);
  });

  it('refuses appearance deliveries that alter collision, binding, placement or part contracts', () => {
    const b = blueprint();
    const session = createSession({ sessionId: 'assets', sessionSeed: 4021 });
    session.registerBlueprint(b, manifest);
    for (const change of [
      { ...b.objects[0].binding!, entityId: 'keeper' },
      { ...b.objects[0].binding!, collider: { min: [-1, 0, -1] as [number, number, number], max: [2, 2, 2] as [number, number, number] } },
      { ...b.objects[0].binding!, parts: [] },
    ]) {
      expect(session.replaceAsset('hiveVisual', 0, { ...b.objects[0], source: reference(2), binding: change }, manifest))
        .toEqual({ ok: false, reason: 'BINDING_MISMATCH' });
    }
    expect(session.revisionOf('hiveVisual')).toBe(0);
    const incompatible = { ...second, sockets: [{ ...second.sockets[0], at: [0, 1, 0] as [number, number, number] }] };
    const badManifest = createAssetManifest({ version: 'worldstream-assets-v1', assets: [incompatible] });
    expect(session.replaceAsset('hiveVisual', 0, { ...b.objects[0], source: reference(2) }, badManifest))
      .toMatchObject({ ok: false, reason: expect.stringContaining('world binding') });
    expect(session.revisionOf('hiveVisual')).toBe(0);
  });

  it('builds a proportion-preserving asset slot and labels unfinished rendering explicitly', async () => {
    const b = blueprint();
    const world = await buildProxyWorldFrom(b, { assets: manifest, mesh: async () => { throw new Error('No SDF expected'); } });
    expect(world.kind).toBe('built');
    if (world.kind !== 'built') return;
    expect(world.slots[0].slot.transform.scale).toEqual([1, 1, 1]);
    expect(world.slots[0].slot.binding?.entityId).toBe('tallHive');
    expect(world.slots[0].form).toMatchObject({ kind: 'asset', reference: reference(), level: 0 });
  });
});
