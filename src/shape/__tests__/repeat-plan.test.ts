import {describe,it,expect,vi} from 'vitest';
import {Box3,InstancedMesh,Vector3} from 'three';
import {planRootRepeat,repeatedBounds} from '../repeat-plan';
import {validateShapeProgram} from '../schema';
import {assessShapeDetail} from '../detail-policy';
import {handleMeshJob} from '../mesh-worker';
import type {ShapeProgram} from '../types';
import type {MeshOrder,MeshResult} from '../mesh-client';
import {meshShapeForRender,type ProxySlot,type ProxyWorld} from '@/worldstream/proxy';
import {slotFromForm} from '@/worldstream/slots';
import {buildStage,admitDetailUpgrade} from '@/components/viewer/WorldstreamStage';
import {PALETTES} from '@/kit';

const shape:ShapeProgram={shapeId:'fins',stableId:'device',nodes:[{kind:'box',size:[1,0.08,0.12]},{kind:'repeat',child:0,count:2,step:[0,1.2,0]}],root:1,
  targetBounds:{min:[-.5,-.04,-.06],max:[.5,1.24,.06]},anchors:[{name:'handle',at:[0,0,0],normal:[0,1,0]}],materialIntent:'metal',priority:2};
async function mesh(order:MeshOrder):Promise<MeshResult>{
  const result=handleMeshJob({...order,jobId:'fixture',unbudgeted:true}).response;
  if(!result.ok)throw new Error(result.error);
  return {...result,shapeId:order.program.shapeId};
}
const object={stableId:'device',label:'device',synonyms:[],role:'hero' as const,importance:3 as const,source:{kind:'shape' as const,shapeId:'fins'},
  targetBounds:{min:[4,2,1] as [number,number,number],max:[6,5,2] as [number,number,number]}};
const slot=slotFromForm(object,{localBounds:shape.targetBounds,anchors:shape.anchors});

describe('bounded root-repeat representation',()=>{
  it('keeps the existing schema gate and improves the unit sampling extent without changing the authored shape',()=>{
    expect(validateShapeProgram(shape).ok).toBe(true);
    const before=structuredClone(shape),plan=planRootRepeat(shape,32);
    expect(plan.kind).toBe('repeat-instanced');if(plan.kind!=='repeat-instanced')return;
    expect(validateShapeProgram(plan.program).ok).toBe(true);
    expect(plan.program.nodes).toHaveLength(1);
    expect(plan.instances.offsets).toEqual([[0,0,0],[0,1.2,0]]);
    expect(repeatedBounds(plan.program.targetBounds,plan.instances)).toEqual(shape.targetBounds);
    expect(assessShapeDetail(plan.program,32).maxVoxelMeters).toBeLessThan(assessShapeDetail(shape,32).maxVoxelMeters);
    expect(shape).toEqual(before);
  });
  it('refuses overlap, wrapped repeats, and an unknown child hidden by a known union hull',()=>{
    expect(planRootRepeat({...shape,nodes:[shape.nodes[0],{kind:'repeat',child:0,count:2,step:[0,.1,0]}]},32)).toMatchObject({kind:'unsupported'});
    expect(planRootRepeat({...shape,nodes:[...shape.nodes,{kind:'translate',child:1,offset:[0,0,0]}],root:2},32)).toMatchObject({kind:'unsupported'});
    const unknown:ShapeProgram={...shape,nodes:[shape.nodes[0],{kind:'plane',normal:[0,1,0],offset:0},{kind:'union',children:[0,1]},{kind:'repeat',child:2,count:2,step:[0,1.2,0]}],root:3};
    expect(planRootRepeat(unknown,32)).toMatchObject({kind:'unsupported'});
  });
  it('counts every rendered copy against rough and high triangle caps',async()=>{
    const unit=await meshShapeForRender(shape,1,16,mesh);
    expect(unit.repeat?.offsets).toHaveLength(2);
    for(const [resolution,count] of [[32,9_000],[48,17_000]]){
      await expect(meshShapeForRender(shape,1,resolution,async()=>({...unit.mesh,triangleCount:count}))).rejects.toThrow('Repeated mesh draws');
    }
  });
  it('renders one stable wrapper with actual internal instances, preserved fitting and one disposal',async()=>{
    const result=await meshShapeForRender(shape,1,16,mesh);
    const entry:ProxySlot={slot,detailProgram:shape,form:{kind:'mesh',rung:'g3-reduced',...result}};
    const world:ProxyWorld={kind:'built',title:'fixture',sessionSeed:1,quality:'full',resolution:16,slots:[entry],scenery:[]};
    const build=buildStage(world,PALETTES.harbor);
    const view=build.registry.view('device')!;
    const instance=view.group.getObjectByProperty('isInstancedMesh',true) as InstancedMesh;
    expect(instance.count).toBe(2);
    expect(build.views).toHaveLength(1);
    expect(build.triangles.get('device')).toBe(result.mesh.triangleCount*2);
    const geometryDispose=vi.spyOn(instance.geometry,'dispose');
    const instanceDispose=vi.spyOn(instance,'dispose');
    view.group.updateMatrixWorld(true);
    const bounds=new Box3().setFromObject(view.group),center=bounds.getCenter(new Vector3());
    expect(center.x).toBeCloseTo(5,2);
    expect(build.socketWorld('device','handle')).not.toBeNull();
    build.dispose();expect(geometryDispose).toHaveBeenCalledTimes(1);expect(instanceDispose).toHaveBeenCalledTimes(1);
  });
  it('rejects whole-grid or changed-source upgrades for a repeated slot',async()=>{
    const result=await meshShapeForRender(shape,1,16,mesh);
    const entry:ProxySlot={slot,detailProgram:shape,form:{kind:'mesh',rung:'g3-reduced',...result}};
    const upgrade={stableId:'device',contentHash:'fixture',level:'high' as const,mesh:result.mesh};
    expect(admitDetailUpgrade(entry,upgrade)).toMatchObject({ok:false,rejection:'REPEAT_PLAN_MISMATCH'});
    expect(admitDetailUpgrade(entry,{...upgrade,repeat:{...result.repeat!,sourceHash:'changed'}})).toMatchObject({ok:false,rejection:'REPEAT_PLAN_MISMATCH'});
    expect(admitDetailUpgrade(entry,{...upgrade,repeat:result.repeat})).toMatchObject({ok:true,triangles:result.mesh.triangleCount*2});
  });
});
