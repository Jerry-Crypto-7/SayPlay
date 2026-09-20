import {compileBlueprint} from '../../src/model/worldstream-compiler';
import {readPlannerEmission} from '../../src/model/worldstream-intent';
import {GEOM_VERSION} from '../../src/geom/program';

/** Věta, na kterou obě odpovědi níž odpovídají; falešný poskytovatel ji dostane na drátě. */
export const STORM_BELL_PROMPT='A hilltop bell that starts a storm when rung; the storm unlocks the gate.';

/**
 * **Zvon, který spustí bouři** (P22 T12) – syrové odpovědi plánovače
 * a kompilátoru, tak jak by je napsal model.
 *
 * Kompilátor píše `lookBindings`: příznak `storm` (0/1) váže na předvolby
 * `day`/`storm`. Pravidlo `ring` příznak nastaví a odemkne bránu, pravidlo
 * `pass` vyhraje jen za bouře – svědek tedy vede přes zvon a svět zůstává
 * dohratelný v obou vzhledech. Předvolba se čte ze stavu, nikdy naopak.
 */
export function stormBellAnswers():{readonly planner:Record<string,unknown>;readonly compiler:Record<string,unknown>} {
  const objects=[{stableId:'hill',label:'Hilltop',synonyms:['hill'],role:'terrain',importance:1},
    {stableId:'bell',label:'Storm bell',synonyms:['bell'],role:'hero',importance:3},
    {stableId:'gate',label:'Stone gate',synonyms:['gate'],role:'prop',importance:2}];
  const provenance={kind:'inferred',reason:'Explicit storm-bell fixture layout.'};
  const planner={intent:{setting:'Windswept hilltop before a storm',mood:'tense, bright before the storm breaks',
    spatialThesis:'A bell stands between the visitor and a stone gate; ringing it calls the storm.',
    actors:['visitor'],heroObjects:['bell'],interactions:['ring the bell to start the storm, then pass the gate'],unsupported:[]},objects,
    sceneSpec:{version:1,requirements:objects.map(o=>({id:`req_${o.stableId}`,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
      instances:objects.map(o=>({stableId:o.stableId,requirementIds:[`req_${o.stableId}`],role:o.role,provenance,attributes:[],orientation:{description:'Facing the gate',provenance}})),relations:[],clarifications:[]}};
  const bellBounds={min:[-0.7,0,-0.7],max:[0.7,1.6,0.7]};
  const compiler={geometry:{version:GEOM_VERSION,nodes:[{kind:'terrain',variant:'flat',extent:[12,12],amplitude:0,seed:3,at:[0,-0.2,0]},
      {kind:'arch',variant:'portal',at:[0,0,-4]},{kind:'group',children:[0,1]}],root:2},
    shapes:[{shapeId:'bellShape',stableId:'bell',nodes:[{kind:'cone',height:1.4,radius:0.6}],root:0,
      targetBounds:{min:[-0.6,0,-0.6],max:[0.6,1.4,0.6]},anchors:[],materialIntent:'metal',priority:3}],
    placements:[{stableId:'hill',source:{kind:'geom',node:0},targetBounds:{min:[-6,-0.4,-6],max:[6,0,6]}},
      {stableId:'bell',source:{kind:'shape',shapeId:'bellShape'},targetBounds:bellBounds,binding:{entityId:'bell',signalFlag:'storm',collider:bellBounds,sockets:[],parts:[]}},
      {stableId:'gate',source:{kind:'geom',node:1},targetBounds:{min:[-1.5,0,-4.6],max:[1.5,3,-3.4]}}],
    lookBindings:[{variable:'storm',values:{'0':'day','1':'storm'}}],
    world:{irVersion:'v1',simRevision:0,lookRevision:0,sim:{layout:{width:8,height:8},grid:{cell:1},sockets:{start:[2,4],bellStand:[4,4],gateway:[6,4]},
      collisionAabb:{visitor:[2,4,1,1],bell:[4,4,1,1],gate:[6,4,1,1]},
      entities:{visitor:{role:'actor',socket:'start',state:'idle'},bell:{role:'prop',socket:'bellStand',state:'silent'},gate:{role:'prop',socket:'gateway',state:'closed',locked:true}},
      state:{counters:{},flags:{storm:{init:false}},timers:{},zones:{},slots:0},rules:{
        ring:{phase:0,priority:0,event:{kind:'onAction',actor:'visitor',actionId:'activate',target:'bell'},condition:null,
          actions:[{kind:'setFlag',flag:'storm',value:true},{kind:'setState',entity:'bell',value:'ringing'},{kind:'setLocked',entity:'gate',value:false}]},
        pass:{phase:0,priority:1,event:{kind:'onAction',actor:'visitor',actionId:'pass',target:'gate'},condition:{kind:'flagIs',flag:'storm',value:true},actions:[{kind:'win'}]}}},
      look:{modules:{},palette:'sand',lightRig:'rim',atmosphere:'clear',materialRoles:{},camera:{},audio:{}}}};
  return {planner,compiler};
}

/** Táž fixture prohnaná produkčním kompilátorem v procesu testu; oracle hashe z ní staví běh bez rendereru. */
export function stormBellWorld() {
  const {planner,compiler}=stormBellAnswers();
  const plan=readPlannerEmission(planner,{requireSceneSpec:true,prompt:STORM_BELL_PROMPT});
  if(!plan.ok)throw new Error(plan.detail);
  const result=compileBlueprint(compiler,plan.value,
    {sessionSeed:1722,upstream:{model:'manual-fixture-no-model',system:'Explicit storm-bell fixture',user:STORM_BELL_PROMPT}});
  if(!result.ok)throw new Error(`${result.reason}: ${result.detail}: ${result.issues.join(';')}`);
  return result.value;
}
