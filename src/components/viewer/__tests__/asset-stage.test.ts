import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import { DEMO_BLUEPRINT } from '@/app/dev/demo-world';
import catalog from '@/assets/catalog.json';
import type { AssetLease } from '@/assets/cache';
import { blueprintSchema } from '@/worldstream/schema';
import { buildProxyWorldFrom } from '@/worldstream/proxy';
import { PALETTES } from '@/kit';
import { buildStage } from '../WorldstreamStage';

async function fixture() {
  const asset = catalog.assets[0];
  return buildProxyWorldFrom(blueprintSchema.parse({ ...DEMO_BLUEPRINT, version: 'worldstream-v2', shapes: [],
    objects: [{ ...DEMO_BLUEPRINT.objects[0], source: { kind: 'asset', assetId: asset.assetId, version: asset.version, hash: asset.hash },
      binding: { collider: DEMO_BLUEPRINT.objects[0].targetBounds, sockets: [], parts: [] } }] }),
  { mesh: async () => { throw new Error('unexpected mesh'); } });
}

describe('async asset representation lifetime', () => {
  it('suspends detail, releases late requests and reloads with identical wrapper and sockets',async()=>{
    const world=await fixture();if(world.kind!=='built')throw new Error('fixture');
    const entry=world.slots[0];const ordinary={...world,slots:[{...entry,slot:{...entry.slot,role:'prop' as const,importance:2 as const}}]};
    const releases:ReturnType<typeof vi.fn>[]=[],deliveries:((lease:AssetLease)=>void)[]=[];
    const stage=buildStage(ordinary,PALETTES.harbor,{acquire:()=>new Promise(resolve=>deliveries.push(resolve))});
    const id=entry.slot.stableId,error=vi.fn(),wrapper=stage.registry.view(id)!.group;
    const deliver=(index:number)=>{const release=vi.fn();releases.push(release);deliveries[index]({object:new Group(),release,hash:catalog.assets[0].lods[0].hash,triangles:100});};
    stage.loadAssets(error);deliver(0);await Promise.resolve();await Promise.resolve();
    wrapper.position.x+=7;const position=wrapper.position.clone();
    expect(stage.suspendAsset(id)).toBe(true);expect(stage.assetRetryState(id).status).toBe('unavailable');expect(releases[0]).toHaveBeenCalledOnce();
    expect(stage.registry.view(id)!.group).toBe(wrapper);expect(wrapper.position).toEqual(position);
    expect(stage.registry.view(id)!.contentHash).toBeNull();expect(stage.rungs.get(id)).toBe('semantic-clay');
    stage.loadAssets(error);expect(deliveries).toHaveLength(1);
    stage.requestAssetLod(id,0,error);stage.suspendAsset(id);deliver(1);await Promise.resolve();await Promise.resolve();
    expect(releases[1]).toHaveBeenCalledOnce();expect(stage.registry.view(id)!.contentHash).toBeNull();
    for(let zone=0;zone<3;zone++) {
      stage.requestAssetLod(id,0,error);deliver(zone+2);await Promise.resolve();await Promise.resolve();
      expect(stage.registry.view(id)!.group).toBe(wrapper);expect(wrapper.position).toEqual(position);
      expect(stage.suspended.has(id)).toBe(false);stage.suspendAsset(id);
    }
    expect(releases.every(release=>release.mock.calls.length===1)).toBe(true);stage.dispose();
    const protectedStage=buildStage({...world,slots:[{...entry,slot:{...entry.slot,role:'hero',importance:2}}]},PALETTES.harbor);
    expect(protectedStage.suspendAsset(id)).toBe(false);protectedStage.dispose();
  });
  it('keeps the visible GLB and moved wrapper until a replacement LOD is ready; stale LOD is released', async () => {
    const world=await fixture();if(world.kind!=='built') throw new Error('fixture');
    const requests: {level:number;deliver:(lease:AssetLease)=>void}[]=[];
    const stage=buildStage(world,PALETTES.harbor,{acquire:(_reference,level=0)=>new Promise(resolve=>requests.push({level,deliver:resolve}))});
    const id=world.slots[0].slot.stableId,error=vi.fn();
    const first=new Group(),firstRelease=vi.fn();
    stage.loadAssets(error);requests[0].deliver({object:first,release:firstRelease,hash:catalog.assets[0].lods[0].hash,triangles:100});
    await Promise.resolve();await Promise.resolve();
    const wrapper=stage.registry.view(id)!.group;wrapper.position.x+=3;
    const moved=wrapper.position.clone();
    stage.requestAssetLod(id,1,error);
    expect(stage.registry.view(id)!.attached).toBe(first);expect(firstRelease).not.toHaveBeenCalled();
    // Re-entering the near zone cancels the far candidate before it arrives.
    stage.requestAssetLod(id,0,error);
    const staleRelease=vi.fn();requests[1].deliver({object:new Group(),release:staleRelease,hash:catalog.assets[0].lods[1].hash,triangles:50});
    await Promise.resolve();await Promise.resolve();expect(staleRelease).toHaveBeenCalledOnce();
    stage.requestAssetLod(id,1,error);
    const second=new Group();requests[2].deliver({object:second,release:vi.fn(),hash:catalog.assets[0].lods[1].hash,triangles:50});
    await Promise.resolve();await Promise.resolve();
    expect(stage.registry.view(id)!.group).toBe(wrapper);expect(wrapper.position).toEqual(moved);
    expect(stage.registry.view(id)!.attached).toBe(second);expect(firstRelease).toHaveBeenCalledOnce();stage.dispose();
  });
  it('failed texture/LOD acquisition retains the last good model and does not retry every frame', async () => {
    const world=await fixture();if(world.kind!=='built') throw new Error('fixture');
    const object=new Group();
    const acquire=vi.fn(async (_reference:unknown,level=0)=>{if(level===1)throw new Error('Texture decode failed');return {object,release:vi.fn(),hash:catalog.assets[0].hash,triangles:100};});
    const stage=buildStage(world,PALETTES.harbor,{acquire});const id=world.slots[0].slot.stableId,error=vi.fn();
    stage.loadAssets(error);await Promise.resolve();await Promise.resolve();
    stage.requestAssetLod(id,1,error);await Promise.resolve();await Promise.resolve();
    stage.requestAssetLod(id,1,error);await Promise.resolve();
    expect(acquire).toHaveBeenCalledTimes(2);expect(stage.registry.view(id)!.attached).toBe(object);
    expect(error).toHaveBeenCalledWith(id,'Texture decode failed');stage.dispose();
  });
  it('opaque GLB parts cast contact shadows while transparent glass does not become an opaque blocker', async () => {
    const world = await fixture();
    const object = new Group(), geometry = new BoxGeometry();
    const opaque = new MeshStandardMaterial(), glass = new MeshStandardMaterial({ transparent: true, opacity: 0.3 });
    const solid = new Mesh(geometry, opaque), pane = new Mesh(geometry, glass);
    object.add(solid, pane);
    const stage = buildStage(world, PALETTES.harbor, { acquire: async () => ({ object, release: () => {}, hash: catalog.assets[0].hash, triangles: 24 }) });
    stage.loadAssets(vi.fn()); await Promise.resolve(); await Promise.resolve();
    expect(solid.castShadow).toBe(true); expect(solid.receiveShadow).toBe(true);
    expect(pane.castShadow).toBe(false); expect(pane.material).toBe(glass);
    stage.dispose(); geometry.dispose(); opaque.dispose(); glass.dispose();
  });
  it.each(['remove', 'revise', 'dispose'] as const)('releases late GLB after %s instead of attaching stale data', async mode => {
    const world = await fixture();
    if (world.kind !== 'built') throw new Error('fixture');
    let deliver!: (lease: AssetLease) => void;
    const stage = buildStage(world, PALETTES.harbor, { acquire: () => new Promise(resolve => { deliver = resolve; }) });
    const error = vi.fn(); stage.loadAssets(error);
    const id = world.slots[0].slot.stableId;
    if (mode === 'remove') stage.reconcile({ ...world, slots: [] }, PALETTES.harbor);
    if (mode === 'revise') stage.registry.revise(id);
    if (mode === 'dispose') stage.dispose();
    const release = vi.fn(); const object = new Group();
    deliver({ object, release, hash: catalog.assets[0].hash, triangles: 100 });
    await Promise.resolve(); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(object.parent).toBeNull();
    stage.dispose();
  });

  it('keeps wrapper and sockets and releases a cached lease through registry disposal', async () => {
    const world = await fixture();
    if (world.kind !== 'built') throw new Error('fixture');
    const release = vi.fn(); const object = new Group();
    const stage = buildStage(world, PALETTES.harbor, { acquire: async () => ({ object, release, hash: catalog.assets[0].hash, triangles: 100 }) });
    const id = world.slots[0].slot.stableId;
    const before = stage.registry.view(id)!;
    stage.loadAssets(vi.fn()); await Promise.resolve(); await Promise.resolve();
    const after = stage.registry.view(id)!;
    expect(after.group).toBe(before.group);
    expect(after.attached).toBe(object);
    expect(after.group.children.filter(c => c !== object)).toEqual(before.group.children.filter(c => c !== object));
    stage.dispose(); expect(release).toHaveBeenCalledOnce();
  });
});


describe('one explicit accepted asset load repair',()=>{
  const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
  it('repairs a failed approved asset once with unchanged wrapper, bounds, sockets and revision',async()=>{
    const world=await fixture();if(world.kind!=='built')throw Error('fixture');
    const before=JSON.stringify(world),id=world.slots[0].slot.stableId,object=new Group(),release=vi.fn();
    const acquire=vi.fn().mockRejectedValueOnce(Error('fixture network failure')).mockResolvedValue({object,release,hash:catalog.assets[0].lods[0].hash,triangles:100});
    const stage=buildStage(world,PALETTES.harbor,{acquire}),error=vi.fn();const view=stage.registry.view(id)!;
    const uuid=view.group.uuid,revision=view.revision,transform=view.group.matrix.toArray(),sockets=view.group.children.filter(c=>c!==view.attached);
    expect(stage.assetRetryState(id).status).toBe('unavailable');stage.loadAssets(error);await flush();
    expect(stage.assetRetryState(id).status).toBe('available');stage.loadAssets(error);await flush();expect(acquire).toHaveBeenCalledTimes(1);
    const pending=stage.retryAsset(id,error);expect(stage.assetRetryState(id).status).toBe('running');
    expect((await stage.retryAsset(id,error)).status).toBe('exhausted');expect((await pending).status).toBe('loaded');
    expect(stage.assetRetryState(id).status).toBe('succeeded');expect(acquire).toHaveBeenCalledTimes(2);expect(acquire.mock.calls[1]).toEqual(acquire.mock.calls[0]);
    const after=stage.registry.view(id)!;expect(after.group.uuid).toBe(uuid);expect(after.revision).toBe(revision);expect(after.group.matrix.toArray()).toEqual(transform);expect(sockets.every(socket=>socket.parent===after.group)).toBe(true);expect(JSON.stringify(world)).toBe(before);
    expect((await stage.retryAsset(id,error)).status).toBe('exhausted');stage.dispose();expect(release).toHaveBeenCalledOnce();
  });
  it('exhausts permanent transport failure without an automatic same-LOD loop',async()=>{
    const world=await fixture();if(world.kind!=='built')throw Error('fixture');const id=world.slots[0].slot.stableId;
    const acquire=vi.fn().mockRejectedValue(Error('offline')),stage=buildStage(world,PALETTES.harbor,{acquire});stage.loadAssets(vi.fn());await flush();
    expect((await stage.retryAsset(id,vi.fn())).status).toBe('failed');expect(stage.assetRetryState(id).status).toBe('exhausted');stage.loadAssets(vi.fn());await flush();expect(acquire).toHaveBeenCalledTimes(2);stage.dispose();
  });
  it.each(['remove','revise','dispose'] as const)('settles stale retry and releases its late lease after %s',async mode=>{
    const world=await fixture();if(world.kind!=='built')throw Error('fixture');const id=world.slots[0].slot.stableId;
    let deliver!:(lease:AssetLease)=>void;const acquire=vi.fn().mockRejectedValueOnce(Error('offline')).mockImplementation(()=>new Promise(resolve=>{deliver=resolve;}));
    const stage=buildStage(world,PALETTES.harbor,{acquire});stage.loadAssets(vi.fn());await flush();const retry=stage.retryAsset(id,vi.fn());
    if(mode==='remove')stage.reconcile({...world,slots:[]},PALETTES.harbor);if(mode==='revise')stage.registry.revise(id);if(mode==='dispose')stage.dispose();
    const release=vi.fn();deliver({object:new Group(),release,hash:catalog.assets[0].lods[0].hash,triangles:100});expect((await retry).status).toBe('stale');await flush();expect(release).toHaveBeenCalledOnce();stage.dispose();
  });
});

it('does not turn registry revision refusal into a retryable network failure',async()=>{
 const world=await fixture();if(world.kind!=='built')throw Error('fixture');const id=world.slots[0].slot.stableId;
 let deliver!:(lease:AssetLease)=>void;const stage=buildStage(world,PALETTES.harbor,{acquire:()=>new Promise(resolve=>{deliver=resolve;})});
 stage.loadAssets(vi.fn());stage.registry.revise(id);const release=vi.fn();deliver({object:new Group(),release,hash:catalog.assets[0].lods[0].hash,triangles:100});
 await Promise.resolve();await Promise.resolve();expect(stage.assetRetryState(id).status).toBe('unavailable');expect((await stage.retryAsset(id,vi.fn())).status).toBe('unavailable');expect(release).toHaveBeenCalledOnce();stage.dispose();
});
