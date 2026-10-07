import { describe, expect, it } from 'vitest';
import { asset } from '@/assets/__fixtures__/catalog';
import { createAssetManifest } from '@/assets/manifest';
import { sealSimHash } from '@/ir/worlddoc';
import { repairEmission } from '@/model/repair';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import { blueprintSchema, type WorldstreamBlueprint } from '../schema';
import { findBlueprintReferenceIssues } from '../references';
import { buildProxyWorldFrom } from '../proxy';

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
