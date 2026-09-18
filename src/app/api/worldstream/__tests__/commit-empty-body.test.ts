import {afterEach,expect,it} from 'vitest';
import {POST} from '../sessions/[sessionId]/changes/[changeId]/commit/route';
import {generated,ANSWER} from './world-fixture';
import {clearSessions,putChange,peekChange} from '@/worldstream/sessions';
import {resetRateWindows} from '@/server/rate-limit';
import type {RefinePlan} from '@/model/worldstream-refine';

afterEach(()=>{clearSessions();resetRateWindows();});
it.each([undefined,''])('accepts a bodyless shape commit with body=%j including Next empty streams',async body=>{
  const stored=await generated(),world=stored.blueprint!.world;
  const plan:RefinePlan={stableId:'ironMast',summary:'Explicit fixture shape replacement',shape:(ANSWER.shapes as unknown[])[0] as RefinePlan['shape'],addition:null,appearance:[],behavior:[]};
  putChange(stored,{changeId:'shape',plan,basedOn:{representation:stored.session.revisionOf('ironMast')??0,sim:world.simRevision,look:world.lookRevision}});
  const request=new Request('http://127.0.0.1/commit',{method:'POST',...(body===undefined?{}:{body})});
  if(body==='')expect(request.body).not.toBeNull();
  const response=await POST(request,{params:Promise.resolve({sessionId:stored.session.sessionId,changeId:'shape'})});
  const result=await response.json();expect(response.status,JSON.stringify(result)).toBe(200);expect(result.outcome).toBe('COMMITTED');
});
it.each([' ','{','null','{}'])('rejects nonempty invalid comparison %j without consuming the change',async body=>{
  const stored=await generated(),world=stored.blueprint!.world;
  putChange(stored,{changeId:'untouched',plan:{stableId:'ironMast',summary:'Untouched fixture',shape:null,addition:null,appearance:[],behavior:[]},basedOn:{representation:0,sim:world.simRevision,look:world.lookRevision}});
  const response=await POST(new Request('http://127.0.0.1/commit',{method:'POST',body}),{params:Promise.resolve({sessionId:stored.session.sessionId,changeId:'untouched'})});
  expect(response.status).toBe(400);expect((await response.json()).error.code).toBe('INVALID_COMPARISON');expect(peekChange(stored,'untouched')).not.toBeNull();
});
