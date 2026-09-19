import {afterEach,expect,it,vi} from 'vitest';
import {PLAN,ANSWER,grammar} from '@/app/api/worldstream/__tests__/world-fixture';
import {clearSessions,openSession,runGeneration} from '../sessions';
import {GET} from '@/app/api/worldstream/sessions/[sessionId]/route';
import type {PlannerEmission} from '@/model/worldstream-intent';
import {buildIntentPreview} from '@/scene/intent-preview';
import {isMassingPreview,isWordMassing} from '@/scene/massing-preview';
afterEach(clearSessions);
function ownPlan():PlannerEmission {
  const provenance={kind:'inferred' as const,reason:'Explicit regression fixture'};
  return {...structuredClone(PLAN),sceneSpec:{version:1,clarifications:[],relations:[],
    requirements:PLAN.objects.map(o=>({id:o.stableId,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
    instances:PLAN.objects.map(o=>({stableId:o.stableId,requirementIds:[o.stableId],role:o.role,provenance,attributes:[],orientation:{description:'upright',provenance}}))}};
}
it('publishes own validated layout before the compiler returns, reconnects without runtime, and replaces only on acceptance',async()=>{
  const stored=openSession('early-layout-session',4021)!;let calls=0,finish!:(value:unknown)=>void;
  const pending=runGeneration(stored,PLAN.intent.setting,{grammar:grammar(),emit:async()=>{
    calls++;return calls===1?ownPlan():new Promise(resolve=>{finish=resolve;});
  }});
  // Od P21 T4 stojí v tom slotu nejdřív hmoty ze slov věty (`stage` mají týž),
  // takže se čeká na náhled, který napsal plánovač — ne na první náhled vůbec.
  await vi.waitFor(()=>expect(isWordMassing(stored.visualPreview!)).toBe(false));
  expect(stored.visualPreview?.stage).toBe('intent-layout');
  expect(calls).toBe(2);expect(stored.blueprint).toBeNull();expect(stored.sharedWorld).toBeNull();
  const events=stored.session.events.all();
  // První `visual.preview` jsou hmoty ze slov (před `intent.ready`); ten plánovačský je až za ním.
  expect(events.findIndex(e=>e.type==='intent.ready')).toBeLessThan(events.map(e=>e.type).lastIndexOf('visual.preview'));
  expect(events.some(e=>e.type==='world.ready'||e.type==='blueprint.ready')).toBe(false);
  const response=await GET(new Request('http://localhost'),{params:Promise.resolve({sessionId:'early-layout-session'})});
  const snapshot=await response.json();expect(snapshot.blueprint).toBeNull();
  expect(snapshot.visualPreview).toMatchObject({interactive:false,stage:'intent-layout'});
  // Plán, který přísný náhled přijme, hrubou zástupku nedostane.
  expect(isMassingPreview(stored.visualPreview!)).toBe(false);
  finish(ANSWER);await pending;
  expect(stored.session.phase).toBe('world');expect(stored.visualPreview).toBeNull();expect(stored.blueprint).not.toBeNull();
});
// **Do 18. 9. 2026 tahle relace neposlala nic** a test to tvrdil jako
// vlastnost. Přísný náhled odmítá sedmnáct z osmnácti naměřených plánů, takže
// „přeskočí se" znamenalo prázdnou obrazovku po většinu čekání; zastupuje ho
// hrubý hmotový model, který relace nečte (P21 T2).
it('unsupported early relations fall back to the rough massing preview and still request real compilation',async()=>{
  const plan=ownPlan();plan.sceneSpec!.relations.push({subjectId:'ironMast',targetId:'saltFlat',relation:'against',provenance:{kind:'inferred',reason:'Explicit unsupported early relation'}});
  const stored=openSession('early-layout-unsupported',4021)!;let calls=0;
  await runGeneration(stored,PLAN.intent.setting,{grammar:grammar(),emit:async()=>++calls===1?plan:{geometry:'invalid'}});
  expect(calls).toBeGreaterThan(1);expect(stored.blueprint).toBeNull();
  expect(buildIntentPreview(plan,{sessionSeed:4021})).toMatchObject({ok:false,reason:'UNSUPPORTED_RELATION'});
  expect(isMassingPreview(stored.visualPreview!)).toBe(true);
  expect(stored.visualPreview!.objects.map(o=>o.stableId)).toEqual(plan.objects.map(o=>o.stableId));
  expect(stored.session.events.all().some(e=>e.type==='visual.preview')).toBe(true);
});
