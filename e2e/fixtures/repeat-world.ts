import {compileBlueprint} from '../../src/model/worldstream-compiler';
import {readPlannerEmission} from '../../src/model/worldstream-intent';
import {GEOM_VERSION} from '../../src/geom/program';

/** Explicit compiler emissions fixture. No live generation or authored fallback. */
export function repeatWorld(){
  const prompt='A small workshop platform with a twin-fin assembly that lights up when activated.';
  const provenance={kind:'inferred',reason:'Explicit bounded repeat regression fixture.'};
  const objects=[{stableId:'platform',label:'Workshop platform',synonyms:[],role:'terrain',importance:1},
    {stableId:'fins',label:'Twin-fin assembly',synonyms:['assembly'],role:'hero',importance:3}];
  const plan=readPlannerEmission({intent:{setting:'Small workshop platform',mood:'clear daylight',spatialThesis:'Two separated fins form one assembly on the platform.',
    actors:['visitor'],heroObjects:['fins'],interactions:['activate the assembly'],unsupported:[]},objects,
    sceneSpec:{version:1,requirements:objects.map(o=>({id:`req_${o.stableId}`,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
      instances:objects.map(o=>({stableId:o.stableId,requirementIds:[`req_${o.stableId}`],role:o.role,provenance,attributes:[],orientation:{description:'Aligned with the platform axes',provenance}})),relations:[],clarifications:[]}},
    {requireSceneSpec:true,prompt});
  if(!plan.ok)throw new Error(plan.detail);
  const targetBounds={min:[-2,.2,-.24],max:[2,2.76,.24]};
  const result=compileBlueprint({geometry:{version:GEOM_VERSION,nodes:[{kind:'terrain',variant:'flat',extent:[8,8],amplitude:0,seed:1,at:[0,-.2,0]}],root:0},
    shapes:[{shapeId:'finShape',stableId:'fins',nodes:[{kind:'box',size:[1,.08,.12]},{kind:'repeat',child:0,count:2,step:[0,1.2,0]}],root:1,
      targetBounds:{min:[-.5,-.04,-.06],max:[.5,1.24,.06]},anchors:[],materialIntent:'metal',priority:3}],
    placements:[{stableId:'platform',source:{kind:'geom',node:0},targetBounds:{min:[-4,-.4,-4],max:[4,0,4]}},
      {stableId:'fins',source:{kind:'shape',shapeId:'finShape'},targetBounds,binding:{entityId:'fins',collider:targetBounds,sockets:[],parts:[]}}],
    world:{irVersion:'v1',simRevision:0,lookRevision:0,sim:{layout:{width:8,height:8},grid:{cell:1},sockets:{start:[3,3],device:[4,3]},
      collisionAabb:{},entities:{visitor:{role:'actor',socket:'start',state:'idle'},fins:{role:'prop',socket:'device',state:'off'}},
      state:{counters:{},flags:{},timers:{},zones:{},slots:0},rules:{activate:{phase:0,priority:0,event:{kind:'onAction',actor:'visitor',actionId:'activate',target:'fins'},condition:null,
        actions:[{kind:'setState',entity:'fins',value:'lit'},{kind:'win'}]}}},
      look:{modules:{},palette:'sand',lightRig:'rim',atmosphere:'clear',materialRoles:{},camera:{},audio:{}}}},plan.value,
      {sessionSeed:1719,upstream:{model:'manual-fixture-no-model',system:'Explicit repeat compiler fixture',user:prompt}});
  if(!result.ok)throw new Error(`${result.reason}: ${result.detail}: ${result.issues.join(';')}`);
  return result.value;
}
