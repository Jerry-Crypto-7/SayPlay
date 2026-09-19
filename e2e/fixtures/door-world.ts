import {WORLDSTREAM_ASSETS} from '../../src/assets/catalog';
import {transformBounds} from '../../src/assets/transform';
import {compileBlueprint} from '../../src/model/worldstream-compiler';
import {readPlannerEmission} from '../../src/model/worldstream-intent';
import {GEOM_VERSION} from '../../src/geom/program';

/** Věta, na kterou obě odpovědi níž odpovídají; e2e s falešným poskytovatelem ji píše do pole. */
export const DOOR_PROMPT='A room with a locked panel door, opened by activating the door.';

/**
 * Syrové odpovědi plánovače a kompilátoru, tak jak by je napsal model.
 *
 * Oddělené od `doorWorld()` kvůli e2e cache odpovědí (P16 T6): falešný
 * poskytovatel je vydává na drátě a server je prožene skutečnými branami —
 * tedy touž cestou, kterou níž jde `doorWorld()` v procesu testu.
 */
export function doorAnswers():{readonly planner:Record<string,unknown>;readonly compiler:Record<string,unknown>} {
  const asset=WORLDSTREAM_ASSETS.candidates().find(a=>a.assetId==='panel-door')!;
  const bounds=transformBounds({scale:[1,1,1],translation:[0,0,3]},asset.bounds);
  const objects=[{stableId:'room',label:'Room',synonyms:[],role:'architecture',importance:2},
    {stableId:'gate',label:'Panel door',synonyms:['door'],role:'prop',importance:3}];
  const provenance={kind:'inferred',reason:'Explicit fixture dimensions and layout.'};
  const planner={intent:{setting:'Daylit room',mood:'calm daylight',spatialThesis:'A hinged panel fits the south wall opening.',
    actors:['visitor'],heroObjects:['gate'],interactions:['activate the door to unlock it, then pass'],unsupported:[]},objects,
    sceneSpec:{version:1,requirements:objects.map(o=>({id:`req_${o.stableId}`,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
      instances:objects.map(o=>({stableId:o.stableId,requirementIds:[`req_${o.stableId}`],role:o.role,provenance,attributes:[],orientation:{description:'Facing south',provenance}})),relations:[],clarifications:[]}};
  const compiler={geometry:{version:GEOM_VERSION,nodes:[{kind:'terrain',variant:'plateau',extent:[6,6],amplitude:0,seed:1,at:[0,-0.4,0]}],root:0},shapes:[],
    architecture:[{stableId:'room',kind:'room',at:[0,0,0],width:6,depth:6,height:3,thickness:0.22,openings:[{wall:'south',offset:2.4,width:1.2,height:2.3}]}],
    placements:[{stableId:'room',source:{kind:'architecture'},targetBounds:{min:[-3,0,-3],max:[3,3,3]}},
      {stableId:'gate',source:{kind:'asset',assetId:asset.assetId,version:asset.version,hash:asset.hash},targetBounds:bounds,
        binding:{entityId:'gate',collider:bounds,sockets:[{id:'hinge',at:[-0.47,0,3],normal:[0,1,0]}],parts:[{id:'leaf',sockets:['hinge']}]}}],
    world:{irVersion:'v1',simRevision:0,lookRevision:0,sim:{layout:{width:8,height:8},grid:{cell:1},sockets:{start:[4,4],door:[4,5]},
      collisionAabb:{visitor:[4,4,1,1],gate:[4,5,1,1]},entities:{visitor:{role:'actor',socket:'start',state:'idle'},gate:{role:'prop',socket:'door',state:'closed',locked:true}},
      state:{counters:{},flags:{},timers:{},zones:{},slots:0},rules:{
        open:{phase:0,priority:0,event:{kind:'onAction',actor:'visitor',actionId:'activate',target:'gate'},condition:null,actions:[{kind:'setLocked',entity:'gate',value:false}]},
        pass:{phase:0,priority:1,event:{kind:'onAction',actor:'visitor',actionId:'pass',target:'gate'},condition:{kind:'lockedIs',entity:'gate',value:false},actions:[{kind:'win'}]}}},
      look:{modules:{},palette:'sand',lightRig:'rim',atmosphere:'clear',materialRoles:{},camera:{},audio:{}}}};
  return {planner,compiler};
}

/** Explicit emissions fixture compiled by the production compiler, never a fallback. */
export function doorWorld() {
  const {planner,compiler}=doorAnswers();
  const plan=readPlannerEmission(planner,{requireSceneSpec:true,prompt:DOOR_PROMPT});
  if(!plan.ok)throw new Error(plan.detail);
  const result=compileBlueprint(compiler,plan.value,
      {sessionSeed:1710,upstream:{model:'manual-fixture-no-model',system:'Explicit compiler fixture',user:DOOR_PROMPT},assets:WORLDSTREAM_ASSETS});
  if(!result.ok)throw new Error(`${result.reason}: ${result.detail}: ${result.issues.join(';')}`);
  return result.value;
}
