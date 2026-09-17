import { describe,it,expect } from 'vitest';
import { BoxGeometry,Group,Mesh,MeshBasicMaterial,PerspectiveCamera,Scene } from 'three';
import { observeVisibility,projectedExtent,selectAssetLod } from '../visibility';
const bounds={min:[-1,-1,-1] as const,max:[1,1,1] as const};
function setup() {
  const camera=new PerspectiveCamera(50,1,0.1,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const scene=new Scene(),group=new Group(),geometry=new BoxGeometry(2,2,2),material=new MeshBasicMaterial();
  group.add(new Mesh(geometry,material));scene.add(group);
  return {camera,scene,group,cleanup:()=>{geometry.dispose();material.dispose();}};
}
describe('projection and observed visibility (not recognizability)',()=>{
  it('measures screen extent and rejects an offscreen slot without deleting identity',()=>{
    const {camera,group,cleanup}=setup();
    expect(projectedExtent(bounds,group,camera,1000,1000).screenPixels).toBeGreaterThan(200);
    group.position.x=100;
    expect(projectedExtent(bounds,group,camera,1000,1000)).toMatchObject({inFrame:false,screenPixels:0});cleanup();
  });
  it('reports loaded separately from frame visibility and samples an actual occluder',()=>{
    const {camera,scene,group,cleanup}=setup();
    expect(observeVisibility('person',bounds,group,false,camera,scene,1000,1000)).toMatchObject({loaded:false,samples:0});
    expect(observeVisibility('person',bounds,group,true,camera,scene,1000,1000)).toMatchObject({samples:5,unoccludedSamples:5});
    const geometry=new BoxGeometry(6,6,1),material=new MeshBasicMaterial(),wall=new Mesh(geometry,material);wall.position.z=5;scene.add(wall);
    expect(observeVisibility('person',bounds,group,true,camera,scene,1000,1000)).toMatchObject({samples:5,unoccludedSamples:0});
    wall.visible=false;
    expect(observeVisibility('person',bounds,group,true,camera,scene,1000,1000).unoccludedSamples).toBe(5);
    geometry.dispose();material.dispose();cleanup();
  });
  it('uses screen-space LOD hysteresis and protects important heroes',()=>{
    const lods=[{level:0,minScreenPixels:160},{level:1,minScreenPixels:0}];
    expect(selectAssetLod(lods,100,2,0)).toBe(1);
    expect(selectAssetLod(lods,150,2,0)).toBe(0);
    expect(selectAssetLod(lods,180,2,1)).toBe(1);
    expect(selectAssetLod(lods,210,2,1)).toBe(0);
    expect(selectAssetLod(lods,0,3,1)).toBe(0);
  });
});
