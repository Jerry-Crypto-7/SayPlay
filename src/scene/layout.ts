import { fitAsset, type AssetManifest } from '@/assets/manifest';
import { bakePlacements, compilePlacements } from '@/geom/placements';
import type { GeomProgram } from '@/geom/program';
import type { Bounds3, Vec3 } from '@/shape/types';
import type { SemanticObject } from '@/worldstream/schema';
import type { LayoutBody } from './constraints';
import {transformBounds,rotateY,inversePoint} from '@/assets/transform';
import {heightfieldSampler,CONTACT_TRIANGLE_BUDGET} from './contact';
import type {SceneSpec} from './spec';

/** Measure the same authored geometry / contain fit that the viewer uses. */
export function measureLayout(objects: readonly SemanticObject[], geometry: GeomProgram, assets?: AssetManifest): LayoutBody[] {
  const owners = new Set(objects.flatMap((o) => o.source.kind === 'geom' ? [o.source.node] : []));
  const placements = owners.size ? compilePlacements(geometry, owners) : [];
  const contactBudget={remaining:CONTACT_TRIANGLE_BUDGET};
  try { return objects.flatMap((object): LayoutBody[] => {
    if (object.source.kind === 'asset') {
      const resolved = assets?.resolve(object.source);
      if (!resolved?.ok) return [];
      const asset = resolved.asset;
      const transform = fitAsset(asset,object.targetBounds,object.stretchAxes,object.yaw);
      return [{stableId:object.stableId,bounds:transformBounds(transform,asset.bounds),forward:rotateY([0,0,1],object.yaw??0),
        ...(object.supportSocket?{contact:object.binding?.sockets.find(socket=>socket.id===object.supportSocket)}:{}),
        supportsAt:(point)=>{const local=inversePoint(transform,point);return asset.supportSurfaces.some(s=>Math.abs(local[1]-s.center[1])*transform.scale[1]<=0.08&&Math.abs(local[0]-s.center[0])<=s.width/2+0.08/transform.scale[0]&&Math.abs(local[2]-s.center[2])<=s.depth/2+0.08/transform.scale[2]);},
        ...(asset.tags.includes('door') && object.binding?.entityId ? {passageClosure:'bound-door' as const} : {}),
        supports:asset.supportSurfaces.map((s) => transformBounds(transform,{min:[s.center[0]-s.width/2,s.center[1],s.center[2]-s.depth/2],max:[s.center[0]+s.width/2,s.center[1],s.center[2]+s.depth/2]}))}];
    }
    if (object.source.kind === 'geom') {
      const node = object.source.node;
      const owned = placements.filter((p) => p.owner === node);
      if (!owned.length) return [];
      const mesh = bakePlacements(owned);
      try {
        mesh.computeBoundingBox();
        if (!mesh.boundingBox || mesh.boundingBox.isEmpty()) return [];
        const bounds: Bounds3 = {min:mesh.boundingBox.min.toArray() as Vec3,max:mesh.boundingBox.max.toArray() as Vec3};
        const occupiedBounds = owned.map((placement): Bounds3 => {
          const piece = bakePlacements([placement]);
          try { piece.computeBoundingBox(); return {min:piece.boundingBox!.min.toArray() as Vec3,max:piece.boundingBox!.max.toArray() as Vec3}; }
          finally { piece.dispose(); }
        });
        const sampleGround=object.role==='terrain'?heightfieldSampler(new Float32Array(mesh.getAttribute('position').array),mesh.index?new Uint32Array(mesh.index.array):undefined,contactBudget):undefined;
        return [{stableId:object.stableId,bounds,occupiedBounds,...(sampleGround?{sampleGround}:{})}];
      } finally { mesh.dispose(); }
    }
    return [{stableId:object.stableId,bounds:object.targetBounds}];
  }); } finally {
    const meshes = new Set(placements.flatMap((p) => p.kind === 'mesh' ? [p.geometry] : []));
    for (const mesh of meshes) mesh.dispose();
  }
}

/** Derive only omitted asset yaw from the requested relation. Bindings remain immutable. */
export function orientFacingAssets(objects:readonly SemanticObject[],spec:SceneSpec|undefined,geometry:GeomProgram,assets?:AssetManifest) {
  const facing=spec?.relations.filter(r=>r.relation==='facing')??[];
  if(!facing.length)return {objects:[...objects],oriented:[] as string[]};
  const bodies=new Map(measureLayout(objects,geometry,assets).map(body=>[body.stableId,body]));
  const oriented:string[]=[];
  const result=objects.map(object=>{
    if(object.source.kind!=='asset'||object.yaw!==undefined)return object;
    const relation=facing.find(r=>r.subjectId===object.stableId),subject=bodies.get(object.stableId);
    const target=relation?bodies.get(relation.targetId):undefined;
    if(!subject||!target)return object;
    const dx=(target.bounds.min[0]+target.bounds.max[0]-subject.bounds.min[0]-subject.bounds.max[0])/2;
    const dz=(target.bounds.min[2]+target.bounds.max[2]-subject.bounds.min[2]-subject.bounds.max[2])/2;
    if(Math.hypot(dx,dz)<0.08)return object;
    oriented.push(object.stableId);
    return {...object,yaw:Math.atan2(dx,dz)};
  });
  return {objects:result,oriented};
}
