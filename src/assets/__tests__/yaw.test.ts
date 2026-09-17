import {describe,it,expect} from 'vitest';
import {Group,Vector3} from 'three';
import {asset} from '../__fixtures__/catalog';
import {assetObjectIssues} from '../binding';
import {fitAsset,createAssetManifest} from '../manifest';
import {slotFromAsset} from '@/worldstream/slots';
import {createRepresentationRegistry} from '@/components/viewer/representation';
import type {SemanticObject} from '@/worldstream/schema';
import {orientFacingAssets,measureLayout} from '@/scene/layout';
import {validateLayout} from '@/scene/constraints';
import type {SceneSpec} from '@/scene/spec';
import {GEOM_VERSION,type GeomProgram} from '@/geom/program';

function fixture() {
  const model=asset();model.bounds={min:[0,0,0],max:[4,2,1]};model.collision=[{kind:'box',bounds:model.bounds}];
  model.sockets=[{id:'front',at:[2,1,1],normal:[0,0,1]}];model.parts=[{id:'body',node:'Body',pivot:[0,0,0],sockets:['front']}];
  const object:SemanticObject={stableId:'person',label:'person',synonyms:[],role:'hero',importance:3,source:{kind:'asset',assetId:model.assetId,version:1,hash:model.hash},yaw:Math.PI/2,targetBounds:{min:[-1,0,-4],max:[1,4,4]},binding:{collider:{min:[-1,0,-4],max:[1,4,4]},sockets:[{id:'front',at:[1,2,0],normal:[1,0,0]}],parts:[{id:'body',sockets:['front']}]}};
  return {model,object};
}
describe('asset yaw reaches the same renderer frame as the accepted binding',()=>{
  it('validates rotated sockets/normals/collider, and preserves them through swap',()=>{
    const {model,object}=fixture();expect(assetObjectIssues(object,model)).toEqual([]);
    const slot=slotFromAsset(object,model),registry=createRepresentationRegistry();registry.open(slot,new Group());
    const before=registry.socketWorld('person','front')!;before.forEach((v,i)=>expect(v).toBeCloseTo([1,2,0][i]));
    const group=registry.view('person')!.group;
    expect(group.getWorldDirection(new Vector3()).x).toBeCloseTo(1);
    registry.offer({stableId:'person',revision:0,contentHash:'new',bounds:slot.localBounds,object:new Group()});
    expect(registry.view('person')!.group).toBe(group);expect(registry.socketWorld('person','front')).toEqual(before);registry.dispose();
  });
  it('refuses stale socket coordinates, outward collider and anisotropic rotated fit',()=>{
    const {model,object}=fixture();
    const wrong=structuredClone(object);wrong.binding!.sockets[0].normal=[0,0,1];
    expect(assetObjectIssues(wrong,model)[0]).toContain('socket');
    const narrow=structuredClone(object);narrow.binding!.collider.max[2]=1;
    expect(assetObjectIssues(narrow,model)).toContain('Rotated asset collision exceeds the accepted world collider');
    expect(()=>fitAsset(model,object.targetBounds,['x'],Math.PI/2)).toThrow('unsupported');
  });
  it('solves a missing yaw toward an actual target and preserves explicit yaw and binding',()=>{
    const {model,object}=fixture();
    const subject={...object,yaw:undefined,binding:{...object.binding!,sockets:[]}};
    const target:SemanticObject={...subject,stableId:'target',targetBounds:{min:[4,0,-1],max:[6,4,1]},binding:undefined};
    const manifest=createAssetManifest({version:'worldstream-assets-v1',assets:[model]});
    const spec={relations:[{subjectId:'person',targetId:'target',relation:'facing'}]} as SceneSpec;
    const geometry:GeomProgram={version:GEOM_VERSION,nodes:[],root:0};
    const solved=orientFacingAssets([subject,target],spec,geometry,manifest);
    expect(solved.objects[0].yaw).toBeCloseTo(Math.PI/2);expect(solved.objects[0].binding).toBe(subject.binding);
    expect(validateLayout(spec,measureLayout(solved.objects,geometry,manifest))).toEqual([]);
    const explicit=orientFacingAssets([{...subject,yaw:-Math.PI/2},target],spec,geometry,manifest);
    expect(explicit.objects[0].yaw).toBe(-Math.PI/2);
    expect(validateLayout(spec,measureLayout(explicit.objects,geometry,manifest))[0].kind).toBe('unsatisfied');
  });
});
