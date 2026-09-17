import {Material,Mesh,Plane,Vector3,type Object3D} from 'three';
import type {ProxyWorld} from '@/worldstream/proxy';

export interface CutawayPlan {readonly architectureIds:readonly string[];readonly height:number}
/** Presentation-only section through an indoor enclosure. No IDs or room templates. */
export function planCutaway(world:ProxyWorld):CutawayPlan|null {
  if(world.kind!=='built'||world.environment?.kind!=='interior')return null;
  const architecture=world.slots.filter(entry=>entry.slot.role==='architecture');
  if(!architecture.length)return null;
  const min=[0,1,2].map(axis=>Math.min(...architecture.map(e=>e.slot.worldBounds.min[axis])));
  const max=[0,1,2].map(axis=>Math.max(...architecture.map(e=>e.slot.worldBounds.max[axis])));
  if(max[0]-min[0]<2||max[2]-min[2]<2||max[1]-min[1]<1.5)return null;
  const enclosed=world.slots.some(({slot})=>slot.role!=='architecture'&&slot.role!=='terrain'&&slot.role!=='effect'&&[0,1,2].every(axis=>{
    const middle=(slot.worldBounds.min[axis]+slot.worldBounds.max[axis])/2;
    return middle>=min[axis]&&middle<=max[axis];
  }));
  if(!enclosed)return null;
  return {architectureIds:architecture.map(e=>e.slot.stableId),height:min[1]+Math.max(0.45,Math.min(0.85,(max[1]-min[1])*0.22))};
}

/** Material state is restored verbatim on disable, removal or stage unmount. */
export function createCutawayController() {
  const originals=new Map<Material,{planes:Plane[]|null;shadows:boolean;intersection:boolean}>();
  const plane=new Plane(new Vector3(0,-1,0),0);
  const restore=(material:Material)=>{
    const saved=originals.get(material);if(!saved)return;
    material.clippingPlanes=saved.planes;material.clipShadows=saved.shadows;material.clipIntersection=saved.intersection;material.needsUpdate=true;originals.delete(material);
  };
  return {
    update(groups:readonly Object3D[],height:number|null) {
      const current=new Set<Material>();
      if(height!==null) {
        plane.constant=height;
        for(const group of groups)group.traverse(node=>{
          if(!(node instanceof Mesh))return;
          for(const material of Array.isArray(node.material)?node.material:[node.material]) {
            current.add(material);
            if(originals.has(material))continue;
            originals.set(material,{planes:material.clippingPlanes,shadows:material.clipShadows,intersection:material.clipIntersection});
            material.clippingPlanes=[...(material.clippingPlanes??[]),plane];material.clipShadows=true;material.clipIntersection=false;material.needsUpdate=true;
          }
        });
      }
      for(const material of originals.keys())if(!current.has(material))restore(material);
    },
    dispose(){for(const material of originals.keys())restore(material);},
  };
}
