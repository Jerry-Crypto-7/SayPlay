import {readFileSync} from 'node:fs';
import surface from '../../reality-compiler/museum.sim.json';
import {qualityRoot,verifyQualityCorpus} from './corpus';
import {canonical} from '@/ir/worlddoc';
import {certifySteps} from '@/model/certify';
import {planChange,type RefinePlan} from '@/model/worldstream-refine';
import type {UpstreamRequest} from '@/model/prompt';
import {blueprintSchema,type WorldstreamBlueprint} from '@/worldstream/schema';
import {GEOM_VERSION} from '@/geom/program';
import {routePatch} from '@/patch/router';
import {commitRoutedParts} from '@/app/api/edit/commit';
import {compareCommitCandidate} from '@/worldstream/accepted-branch';
import {hasUnsupportedAppearance,hasUnsupportedMotion} from '@/server/worldstream-capabilities';
import type {TraceInput} from '@/sim/interpreter';

export interface A4Spec {id:string;kind:string;baseRule:string;changePrompt:string;horizonTicks:number;expectedOriginal:string;expectedChanged:string}
type Rule={id?:string;event:Record<string,unknown>;condition?:unknown;actions:unknown[]};
export interface A4Fixture {
  spec:A4Spec;blueprint:WorldstreamBlueprint;targetId:string;inputs:TraceInput[];forkTick:number;
  observations:{tick:number;original:Record<string,number>;changed:Record<string,number>}[];
  /** Local test oracle only: never appended to the model request. */
  oracle:RefinePlan;
}
export function a4Specs():A4Spec[]{verifyQualityCorpus();return JSON.parse(readFileSync(`${qualityRoot}a4-cases.json`,'utf8'));}

/** Manual museum-derived substrate. The explicit, separately labelled finish
 * control certifies fixture availability, not success on the intervention oracle.
 * Its input at tick500 is never inserted in the visitor comparison trace. */
export function a4Fixture(spec:A4Spec):A4Fixture {
  const flags={key:false,switch:false,lamp:spec.id==='a04'||spec.id==='a10',helmet:false,left:false,right:false};
  const state={flags,counters:{crystals:{min:0,max:3,initial:0}},timers:{countdown:{durationTicks:400,initial:0}},zones:structuredClone(surface.state.zones)};
  let targetId=['a01','a03','a07'].includes(spec.id)?'case':'sensorA';
  const event={kind:'onAction',actor:'visitor',actionId:'activate',target:targetId};
  const rules:Record<string,Rule>={};
  let ruleId='rule',path='/condition',op:'replace'|'remove'='replace',value:unknown=null;
  let original:Record<string,number>={},changed:Record<string,number>={};
  const inputs:TraceInput[]=[{tick:20,actor:'visitor',actionId:'activate',target:targetId}];
  const open={kind:'setLocked',target:'case',value:false},light={kind:'setFlag',ref:'lamp',value:true};
  switch(spec.id){
    case'a01':case'a07':rules.rule={event,condition:{kind:'flagIs',ref:spec.id==='a01'?'key':'helmet',value:true},actions:[open]};op='remove';original={'e:case:locked':1};changed={'e:case:locked':0};break;
    case'a02':rules.rule={event,condition:{kind:'flagIs',ref:'switch',value:true},actions:[light]};value={kind:'flagIs',ref:'switch',value:false};original={'f:lamp':0};changed={'f:lamp':1};break;
    case'a03':rules.rule={event,condition:{kind:'counterIs',ref:'crystals',op:'>=',value:3},actions:[open]};value={kind:'counterIs',ref:'crystals',op:'>=',value:1};
      rules.collect={event:{kind:'onAction',actor:'visitor',actionId:'collect',target:'sensorB'},actions:[{kind:'addCounter',ref:'crystals',by:1}]};inputs.unshift({tick:10,actor:'visitor',actionId:'collect',target:'sensorB'});original={'e:case:locked':1};changed={'e:case:locked':0};break;
    case'a04':rules.rule={event,actions:[light]};path='/actions/0';value={...light,value:false};original={'f:lamp':1};changed={'f:lamp':0};break;
    case'a05':rules.rule={event,actions:[open]};path='/actions/0';value={...open,value:true};original={'e:case:locked':0};changed={'e:case:locked':1};break;
    case'a06':rules.plate={event:{kind:'onEnterZone',entity:'visitor',zone:'sensorA'},actions:[{kind:'setFlag',ref:'left',value:true}]};ruleId='plate';path='/actions/0';value={kind:'setFlag',ref:'right',value:true};inputs[0]={...inputs[0],actionId:'moveTo'};original={'f:left':1,'f:right':0};changed={'f:left':0,'f:right':1};break;
    case'a08':rules.turnOn={event,condition:{kind:'flagIs',ref:'lamp',value:false},actions:[light]};rules.turnOff={event,condition:{kind:'flagIs',ref:'lamp',value:true},actions:[{...light,value:false}]};ruleId='turnOff';path='/actions/0';value=light;inputs.push({...inputs[0],tick:40});original={'f:lamp':0};changed={'f:lamp':1};break;
    case'a09':case'a10':{const gate=spec.id==='a09';rules.start={event,actions:[{kind:'startTimer',ref:'countdown',durationTicks:gate?100:40}]};rules.expire={event:{kind:'onTimerEnd',timer:'countdown'},actions:[gate?open:{...light,value:false}]};ruleId='start';path='/actions/0';value={kind:'startTimer',ref:'countdown',durationTicks:gate?40:100};original={[gate?'e:case:locked':'f:lamp']:gate?1:0};changed={[gate?'e:case:locked':'f:lamp']:gate?0:1};break;}
    default:throw new Error(`Unknown frozen A4 case ${spec.id}`);
  }
  rules.fixtureFinish={event:{kind:'onAction',actor:'visitor',actionId:'finishFixture',target:'approachA'},actions:[{kind:'win'}]};
  for(const [id,rule] of Object.entries(rules))rule.id=id;
  const sim={...structuredClone(surface),state,rules,entities:{...structuredClone(surface.entities),case:{...surface.entities.case,locked:spec.id!=='a05'}},
    witness:{tier:'short',H_cert:600,ops:[{tick:500,actor:'visitor',actionId:'finishFixture',target:'approachA'}]}};
  const world={irVersion:'v1',simRevision:0,lookRevision:0,sim,look:{modules:{},palette:'sand',lightRig:'rim',atmosphere:'clear',materialRoles:{},camera:{},audio:{}}};
  const certifier=certifySteps({promptId:`explicit A4 fixture ${spec.id}`,upstream:{model:'fixture-no-model',system:'Explicit substrate',user:spec.baseRule},provenance:{stage:'a4-fixture'},body:world});
  let certified=certifier.next();while(!certified.done)certified=certifier.next();
  if(certified.value.body.outcome!=='CERTIFIED'||!certified.value.body.doc)throw new Error(`Fixture certification failed: ${JSON.stringify(certified.value.body)}`);
  const labels:Record<string,string>={visitor:'Visitor',sensorA:spec.id==='a05'?'Lever':spec.id==='a06'?'Pressure plate':'Button / switch / lamp',sensorB:'Collectible crystal',approachA:'Fixture finish control (not an intervention target)',approachB:'Marker',case:'Gate / door / hatch'};
  const ids=Object.keys(sim.entities);
  const nodes=ids.map((_,i)=>({kind:'mass',variant:'block',at:[i*1.2,0,0],scale:[.6,.6,.6]}));
  const blueprint=blueprintSchema.parse({version:'worldstream-v2',sessionSeed:4021,title:`Explicit ${spec.id} fixture: ${spec.baseRule}`,
    intent:{setting:spec.baseRule,mood:'test substrate',spatialThesis:'Named existing objects exercise one rule intervention.',actors:['visitor'],heroObjects:[targetId],interactions:[spec.baseRule],unsupported:['Manual test substrate; not a generated scene or visual-quality evidence.']},
    geometry:{version:GEOM_VERSION,nodes:[...nodes,{kind:'group',children:ids.map((_,i)=>i)}],root:nodes.length},shapes:[],world:certified.value.body.doc,
    objects:ids.map((id,i)=>({stableId:id,label:labels[id],synonyms:[],role:'prop',importance:id===targetId?3:1,source:{kind:'geom',node:i},targetBounds:{min:[i*1.2-.3,-.3,-.3],max:[i*1.2+.3,.3,.3]},binding:{entityId:id,collider:{min:[i*1.2-.3,-.3,-.3],max:[i*1.2+.3,.3,.3]},sockets:[],parts:[]}}))});
  const observations=spec.kind==='timer'?[{tick:80,original,changed},{tick:400,original:Object.fromEntries(Object.keys(original).map(k=>[k,0])),changed:Object.fromEntries(Object.keys(changed).map(k=>[k,0]))}]:[{tick:400,original,changed}];
  if(spec.id==='a08')observations.unshift({tick:30,original:{'f:lamp':1},changed:{'f:lamp':1}});
  return {spec,blueprint,targetId,inputs,forkTick:inputs[0].tick-1,observations,
    oracle:{stableId:targetId,summary:'Local expected patch, not sent to model',shape:null,appearance:[],behavior:[op==='remove'?{op,path:`/sim/rules/${ruleId}${path}`}:{op,path:`/sim/rules/${ruleId}${path}`,value}]}};
}

/** Same pure production commit/validation/comparison chain as the HTTP route.
 * Does not claim to test HTTP identity, session persistence, or browser rendering. */
export async function runA4Intervention(fixture:A4Fixture,emit:(request:UpstreamRequest)=>Promise<unknown>){
  const original=fixture.blueprint, before=canonical(original),at=performance.now();
  const outcome=await planChange({prompt:fixture.spec.changePrompt,blueprint:original,target:original.objects.find(o=>o.stableId===fixture.targetId)!,emit});
  const modelAndPlanMs=performance.now()-at;
  if(outcome.kind!=='planned')return {status:'rejected',stage:'plan',failure:outcome,modelAndPlanMs};
  const plan=outcome.plan,commitAt=performance.now();
  if(plan.shape||hasUnsupportedAppearance(plan)||hasUnsupportedMotion(plan,original.world))return {status:'rejected',stage:'capability',failure:plan,modelAndPlanMs};
  const routing=routePatch({operations:[...plan.behavior,...plan.appearance]},original.world);
  if(routing.verdict==='REJECTED')return {status:'rejected',stage:'routing',failure:routing,modelAndPlanMs};
  const committed=commitRoutedParts(original.world,routing.patches.map(p=>({part:p.part,baseRevision:p.part==='sim'?original.world.simRevision:original.world.lookRevision,operations:p.operations})));
  const commitMs=performance.now()-commitAt;
  if(committed.outcome!=='CERTIFIED')return {status:'rejected',stage:'commit',failure:committed,plan,modelAndPlanMs,commitMs};
  const accepted=blueprintSchema.safeParse({...original,world:committed.after});
  if(!accepted.success)return {status:'rejected',stage:'blueprint',failure:accepted.error.issues,plan,modelAndPlanMs,commitMs};
  const replayAt=performance.now(),comparisons=[];let pass=true;
  for(const observation of fixture.observations){
    const request={base:{simRevision:original.world.simRevision,simHash:original.world.simHash,comparisonRevision:0,inputCount:fixture.inputs.length},inputs:fixture.inputs,forkTick:fixture.forkTick,observationTick:observation.tick};
    const compared=compareCommitCandidate(original.world,accepted.data.world,request);
    if(compared.verdict!=='COMPARED'){comparisons.push({tick:observation.tick,failure:compared});pass=false;continue;}
    const result=compared.snapshot.comparison!;
    const repeated=compareCommitCandidate(original.world,accepted.data.world,request);
    const checks={trace:canonical(result.inputLog)===canonical(fixture.inputs),fork:canonical(result.changedAtFork.values)===canonical(result.originalAtFork.values)&&canonical(result.changedAtFork.entities)===canonical(result.originalAtFork.entities),
      forkStateHash:result.changedAtFork.stateHash===result.originalAtFork.stateHash,
      forkTime:result.changedAtFork.tick===fixture.forkTick&&result.originalAtFork.tick===fixture.forkTick&&result.changedAtFork.runState===result.originalAtFork.runState,
      deterministic:canonical(repeated)===canonical(compared),original:Object.entries(observation.original).every(([k,v])=>result.original.values[k]===v),changed:Object.entries(observation.changed).every(([k,v])=>result.changed.values[k]===v)};
    pass&&=Object.values(checks).every(Boolean);comparisons.push({tick:observation.tick,checks,result});
  }
  const unchanged=canonical(original)===before;pass&&=unchanged;
  return {status:pass?'passed':'failed',stage:'comparison',plan,committed,acceptedBlueprint:accepted.data,comparisons,unchanged,modelAndPlanMs,commitMs,replayMs:performance.now()-replayAt};
}
