import {WORLDSTREAM_ASSETS} from '@/assets/catalog';
import {transformBounds,transformPoint,transformNormal} from '@/assets/transform';
import type {AssetRecord} from '@/assets/schema';
import {compileBlueprint} from '@/model/worldstream-compiler';
import {readPlannerEmission,type PlannedObject} from '@/model/worldstream-intent';
import {GEOM_VERSION,type GeomNode,type GeomProgram} from '@/geom/program';
import {measureLayout} from '@/scene/layout';
import type {SceneSpec} from '@/scene/spec';
import type {SemanticObject} from '@/worldstream/schema';
import type {Bounds3,Vec3} from '@/shape/types';

/** Hand-authored emissions deliberately run through the real planner reader/compiler.
 * This is a deterministic integration fixture, never a live-generation fallback. */
export function compileSemanticLayoutFixture() {
  const prompt='A reading room with three seated listeners on three chairs facing an aquarium, a wooden bench, a terminal and a plant on a sloped terrace.';
  const catalog=WORLDSTREAM_ASSETS.candidates();
  const get=(id:string)=>{const found=catalog.find(asset=>asset.assetId===id);if(!found)throw new Error(`Missing fixture asset ${id}`);return found;};
  const objects:SemanticObject[]=[];
  const mutableBounds=(b:Bounds3):SemanticObject['targetBounds']=>({min:[...b.min],max:[...b.max]});
  function assetObject(stableId:string,asset:AssetRecord,at:Vec3,scale:number,yaw=0,supportSocket?:string) {
    const transform={scale:[scale,scale,scale] as Vec3,translation:at,rotationY:yaw};
    const targetBounds=mutableBounds(transformBounds(transform,asset.bounds));
    const contact=supportSocket?asset.sockets.find(socket=>socket.id===supportSocket):undefined;
    const object:SemanticObject={stableId,label:asset.label,synonyms:asset.tags,role:'prop',importance:2,yaw,
      source:{kind:'asset',assetId:asset.assetId,version:asset.version,hash:asset.hash},targetBounds,
      ...(supportSocket?{supportSocket}:{}),binding:{collider:targetBounds,sockets:contact?[{id:contact.id,at:[...transformPoint(transform,contact.at)],normal:[...transformNormal(transform,contact.normal)]}]:[],parts:[]}};
    objects.push(object);return object;
  }
  const chair=get('lounge-chair'),person=get('seated-person');
  for(let i=0;i<3;i++) {
    const x=(i-1)*1.8,yaw=Math.atan2(-x,3);
    const seat=assetObject(`chair${i+1}`,chair,[x,0,-1],1,yaw);
    const seatPoint=transformPoint({scale:[1,1,1],translation:[x,0,-1],rotationY:yaw},chair.supportSurfaces[0].center);
    const localSeat=person.sockets.find(s=>s.id==='seat')!;
    const offset=transformPoint({scale:[1.2,1.2,1.2],translation:[0,0,0],rotationY:yaw},localSeat.at);
    assetObject(`listener${i+1}`,person,seatPoint.map((v,axis)=>v-offset[axis]) as unknown as Vec3,1.2,yaw,'seat');
    void seat;
  }
  assetObject('aquarium',get('aquarium'),[0,0,2],2);
  const terminal=assetObject('terminal',get('desktop-terminal'),[-3.7,0,1.7],1.3);
  delete terminal.yaw; // This one exercises the actual missing-yaw facing solver.
  const nodes:GeomNode[]=[{kind:'terrain',variant:'ridge',extent:[6,8],amplitude:0.3,seed:17,at:[8,-0.35,0]}];
  const slab=(x:number,y:number,z:number,w:number,h:number,d:number)=>{
    const index=nodes.length;nodes.push({kind:'sweep',profile:[[-d/2,-w/2],[d/2,-w/2],[d/2,w/2],[-d/2,w/2]],path:[[x,y,z],[x,y+h,z]],segments:2,swatch:'warm'});return index;
  };
  const legs=[slab(-3.6,0,-2.5,0.15,0.45,0.5),slab(-2.4,0,-2.5,0.15,0.45,0.5)],top=slab(-3,0.45,-2.5,1.6,0.12,0.6);
  const benchRoot=nodes.length;nodes.push({kind:'group',children:[...legs,top]});
  nodes.push({kind:'group',children:[0,benchRoot]});
  const geometry:GeomProgram={version:GEOM_VERSION,nodes,root:nodes.length-1};
  const geomObject=(stableId:string,role:SemanticObject['role'],node:number,targetBounds:Bounds3):SemanticObject=>({stableId,label:stableId,synonyms:[],role,importance:2,source:{kind:'geom',node},targetBounds:mutableBounds(targetBounds)});
  const terrain=geomObject('terrace','terrain',0,{min:[5,-1,-4],max:[11,1,4]});objects.push(terrain);
  const ground=measureLayout([terrain],geometry)[0].sampleGround!(8,0)!;
  const plant=get('potted-plant');assetObject('plant',plant,[8,ground.height-plant.bounds.min[1],0],1);
  objects.push(geomObject('bench','prop',benchRoot,{min:[-3.8,0,-2.8],max:[-2.2,0.57,-2.2]}));
  objects.push(geomObject('room','architecture',0,{min:[-5,0,-4],max:[5,3.2,4]}));
  const inferred={kind:'inferred' as const,reason:'Explicit compiler integration fixture placement.'};
  const planned:PlannedObject[]=objects.map(({stableId,label,synonyms,role,importance})=>({stableId,label,synonyms,role,importance}));
  const sceneSpec:SceneSpec={version:1,requirements:planned.map(o=>({id:`req_${o.stableId}`,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance:inferred})),
    instances:planned.map(o=>({stableId:o.stableId,requirementIds:[`req_${o.stableId}`],role:o.role,provenance:inferred,attributes:o.stableId==='room'?[{name:'material',value:'wall',provenance:inferred}]:o.stableId==='bench'?[{name:'material',value:'wood',provenance:inferred}]:[],orientation:{description:'Toward the aquarium where specified',provenance:inferred}})),
    relations:[...Array.from({length:3},(_,i)=>[{subjectId:`listener${i+1}`,relation:'on' as const,targetId:`chair${i+1}`,provenance:inferred},{subjectId:`listener${i+1}`,relation:'facing' as const,targetId:'aquarium',provenance:inferred}]).flat(),
      {subjectId:'terminal',relation:'facing',targetId:'aquarium',provenance:inferred},{subjectId:'plant',relation:'on',targetId:'terrace',provenance:inferred}],clarifications:[]};
  const plan=readPlannerEmission({intent:{setting:'Reading room and a sloped terrace',mood:'calm daylight',spatialThesis:'Three seated listeners face the aquarium beside a sloped terrace.',actors:['listeners'],heroObjects:['aquarium'],interactions:['walk to the exit'],unsupported:[]},objects:planned,sceneSpec},{requireSceneSpec:true,prompt});
  if(!plan.ok)throw new Error(plan.detail);
  const world={irVersion:'v1',simRevision:0,lookRevision:0,sim:{layout:{width:10,height:6},grid:{cell:1},sockets:{start:[1,3],exit:[8,3]},collisionAabb:{visitor:[1,3,1,1],exitDoor:[8,3,1,2]},entities:{visitor:{role:'actor',socket:'start',state:'idle'},exitDoor:{role:'goal',socket:'exit',state:'open'}},state:{counters:{},flags:{},timers:{},zones:{},slots:0},rules:{win:{phase:0,priority:0,event:{kind:'onEnterZone',entity:'visitor',zone:'exit'},condition:null,actions:[{kind:'win'}]}}},look:{modules:{},palette:'sand',lightRig:'rim',atmosphere:'clear',materialRoles:{},camera:{},audio:{}}};
  const result=compileBlueprint({geometry,shapes:[],placements:objects.map(o=>({stableId:o.stableId,source:o.stableId==='room'?{kind:'architecture'}:o.source,targetBounds:o.targetBounds,...(o.binding?{binding:o.binding}:{}),...(o.yaw===undefined?{}:{yaw:o.yaw}),...(o.supportSocket?{supportSocket:o.supportSocket}:{})})),world,
    architecture:[{stableId:'room',kind:'room',at:[0,0,0],width:10,depth:8,height:3.2,thickness:0.18,openings:[{wall:'south',offset:0,width:8,height:3.2},{wall:'east',offset:0,width:8,height:3.2}]}]},plan.value,{sessionSeed:1709,upstream:{model:'manual-fixture-no-model',system:'Explicit fixture',user:prompt},assets:WORLDSTREAM_ASSETS});
  if(!result.ok)throw new Error(`${result.reason}: ${result.detail}\n${result.issues.join('\n')}`);
  return result;
}
