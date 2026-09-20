import {describe,it,expect} from 'vitest';
import {BoxGeometry,Group,Mesh,MeshStandardMaterial,PerspectiveCamera,Plane,Scene,Vector3} from 'three';
import {createCutawayController,planCutaway} from '../cutaway';
import {observeVisibility,visibleIntersection} from '@/scene/visibility';
import type {ProxyWorld} from '@/worldstream/proxy';

const world=(kind='interior',contains=true)=>({kind:'built',environment:{kind},slots:[
  {slot:{stableId:'any-shell',role:'architecture',worldBounds:{min:[-4,-0.2,-4],max:[4,3,4]}}},
  {slot:{stableId:'any-prop',role:'hero',worldBounds:{min:contains?[-0.5,0,-0.5]:[10,0,10],max:contains?[0.5,2,0.5]:[11,2,11]}}},
]} as unknown as ProxyWorld);
describe('reversible semantic indoor cutaway',()=>{
  it('uses indoor enclosure geometry and content, with no asset IDs or templates',()=>{
    const input=world(),before=structuredClone(input),plan=planCutaway(input);
    expect(plan?.architectureIds).toEqual(['any-shell']);expect(plan!.height).toBeGreaterThan(0.4);expect(plan!.height).toBeLessThan(0.9);
    expect(input).toEqual(before);expect(planCutaway(world('exterior'))).toBeNull();expect(planCutaway(world('interior',false))).toBeNull();
  });
  it('clips only passed architecture materials and restores their exact previous state',()=>{
    const geometry=new BoxGeometry(),material=new MeshStandardMaterial(),propMaterial=new MeshStandardMaterial();
    const planes=[new Plane(new Vector3(1,0,0),4)];material.clippingPlanes=planes;
    const architecture=new Group(),prop=new Group();architecture.add(new Mesh(geometry,material));prop.add(new Mesh(geometry,propMaterial));
    const controller=createCutawayController();controller.update([architecture],0.6);
    expect(material.clippingPlanes).toHaveLength(2);expect(material.clipShadows).toBe(true);expect(propMaterial.clippingPlanes).toBeNull();
    const version=material.version;controller.update([architecture],0.7);expect(material.version).toBe(version);
    controller.update([],null);expect(material.clippingPlanes).toBe(planes);expect(material.clipShadows).toBe(false);
    controller.dispose();geometry.dispose();material.dispose();propMaterial.dispose();
  });
  it('ray diagnostics and picking see the same opening as the clipped wall',()=>{
    const scene=new Scene(),subject=new Group(),walls=new Group(),geometry=new BoxGeometry(2,2,2),material=new MeshStandardMaterial();
    subject.add(new Mesh(geometry,material));subject.position.y=1;
    const wallMaterial=new MeshStandardMaterial(),wallGeometry=new BoxGeometry(6,3,0.2),wall=new Mesh(wallGeometry,wallMaterial);wall.position.set(0,1.5,3);walls.add(wall);scene.add(subject,walls);
    const camera=new PerspectiveCamera(50,1,0.1,100);camera.position.set(0,1,10);camera.lookAt(0,1,0);camera.updateMatrixWorld();
    const bounds={min:[-1,-1,-1] as const,max:[1,1,1] as const};
    expect(observeVisibility('subject',bounds,subject,true,camera,scene,1000,1000).unoccludedSamples).toBe(0);
    const controller=createCutawayController();controller.update([walls],0.3);
    expect(observeVisibility('subject',bounds,subject,true,camera,scene,1000,1000).unoccludedSamples).toBeGreaterThan(0);
    expect(visibleIntersection({object:wall,point:new Vector3(0,1,3)})).toBe(false);
    controller.dispose();expect(visibleIntersection({object:wall,point:new Vector3(0,1,3)})).toBe(true);
    geometry.dispose();material.dispose();wallGeometry.dispose();wallMaterial.dispose();
  });
});
