import { Box3, Camera, Frustum, Matrix4, Object3D, Raycaster, Vector3, Mesh,type Material } from 'three';
import type { Bounds3 } from '@/shape/types';
import type { VisualObservation } from './visibility-report';

export function projectedExtent(bounds: Bounds3, group: Object3D, camera: Camera, width: number, height: number) {
  group.updateWorldMatrix(true,false); camera.updateWorldMatrix(true,false);
  const box = new Box3(new Vector3(...bounds.min),new Vector3(...bounds.max)).applyMatrix4(group.matrixWorld);
  const projection = new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const inFrame = new Frustum().setFromProjectionMatrix(projection).intersectsBox(box);
  if (!inFrame) return {inFrame:false,screenPixels:0,box};
  const points = [box.min.x,box.max.x].flatMap(x => [box.min.y,box.max.y].flatMap(y => [box.min.z,box.max.z].map(z => new Vector3(x,y,z).project(camera))));
  // Crossing the near plane: conservative full-screen extent avoids a detail downgrade.
  const crossing = points.some(p => p.z < -1);
  const span = (axis:'x'|'y') => Math.max(0,Math.min(1,Math.max(...points.map(p => p[axis])))-Math.max(-1,Math.min(...points.map(p => p[axis]))));
  return {inFrame:true,screenPixels:crossing ? Math.max(width,height) : Math.max(span('x')*width/2,span('y')*height/2),box};
}

function visible(object: Object3D): boolean { for (let p: Object3D | null = object; p; p=p.parent) if (!p.visible) return false; return true; }
function belongs(object: Object3D, group: Object3D): boolean { for (let p: Object3D | null=object;p;p=p.parent) if(p===group) return true; return false; }
/** CPU picking/ray diagnostics must obey the same section planes as the renderer. */
export function visibleIntersection(hit:{object:Object3D;point:Vector3;face?:{materialIndex:number}|null}):boolean {
  if(!visible(hit.object))return false;
  if(!(hit.object instanceof Mesh))return true;
  const material:Material|undefined=Array.isArray(hit.object.material)?hit.object.material[hit.face?.materialIndex??0]:hit.object.material;
  const planes=material?.clippingPlanes;
  if(!planes?.length)return true;
  const clipped=planes.map(plane=>plane.distanceToPoint(hit.point)<0);
  return !(material?.clipIntersection?clipped.every(Boolean):clipped.some(Boolean));
}

/** Five geometric ray samples; diagnostic visibility, never human recognizability. */
export function observeVisibility(stableId: string, bounds: Bounds3, group: Object3D, loaded: boolean, camera: Camera, scene: Object3D, width: number, height: number): VisualObservation {
  const extent = projectedExtent(bounds,group,camera,width,height);
  const inFrame = extent.inFrame && visible(group);
  const result: VisualObservation = {stableId,built:true,loaded,inFrame,screenPixels:extent.screenPixels,unoccludedSamples:0,samples:0};
  if (!inFrame || !loaded) return result;
  scene.updateWorldMatrix(true,true);
  const center=extent.box.getCenter(new Vector3()), size=extent.box.getSize(new Vector3());
  const points=[center,...[-1,1].flatMap(x=>[-1,1].map(y=>center.clone().add(new Vector3(size.x*x*0.3,size.y*y*0.3,0))))];
  const origin=camera.getWorldPosition(new Vector3());
  const ray=new Raycaster();
  for(const point of points) {
    const projected=point.clone().project(camera);
    if(Math.abs(projected.x)>1 || Math.abs(projected.y)>1 || projected.z < -1 || projected.z>1) continue;
    result.samples++;
    ray.set(origin,point.clone().sub(origin).normalize()); ray.far=origin.distanceTo(point)+size.length();
    const hits=ray.intersectObject(scene,true).filter(visibleIntersection);
    for(const hit of hits) {
      if(belongs(hit.object,group)) { result.unoccludedSamples++; break; }
      if(hit.object instanceof Mesh) {
        const materials=Array.isArray(hit.object.material)?hit.object.material:[hit.object.material];
        if(materials.every(material=>material.transparent && material.opacity<0.9)) continue;
      }
      break;
    }
  }
  return result;
}

/** Hysteresis prevents repeated network/decode work near the LOD boundary. */
export function selectAssetLod(lods: readonly {level:number;minScreenPixels:number}[], pixels: number, importance: number, current: number | null): number {
  const sorted=[...lods].sort((a,b)=>a.level-b.level);
  if(!sorted.length) return 0;
  if(importance===3) return sorted[0].level;
  const desired=sorted.find(lod=>pixels>=lod.minScreenPixels) ?? sorted[sorted.length-1];
  const previous=sorted.find(lod=>lod.level===current);
  if(previous && desired.level!==previous.level) {
    const threshold=desired.level<previous.level?desired.minScreenPixels:previous.minScreenPixels;
    if(desired.level<previous.level && pixels<threshold*1.2) return previous.level;
    if(desired.level>previous.level && pixels>threshold*0.8) return previous.level;
  }
  return desired.level;
}
