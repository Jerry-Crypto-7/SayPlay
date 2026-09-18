import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {DEMO_BLUEPRINT} from '@/app/dev/demo-world';
import {sealSimHash,canonical} from '@/ir/worlddoc';
import {openSession,getSession,putSession,putChange,clearSessions,resetSessionStorageForTests,type StoredSession} from '@/worldstream/sessions';
import {trustedCallerKey,resetRateWindows} from '../rate-limit';
import {openOrdinarySessionStore} from '../session-store';
import {GET as snapshot} from '@/app/api/worldstream/sessions/[sessionId]/route';
import {GET as events} from '@/app/api/worldstream/sessions/[sessionId]/events/route';
import {POST as restore} from '@/app/api/worldstream/sessions/[sessionId]/comparison/restore/route';
import {POST as commit} from '@/app/api/worldstream/sessions/[sessionId]/changes/[changeId]/commit/route';
import {MAX_LOG_EVENTS} from '@/worldstream/events';
vi.mock('@/server/kill-switch',()=>({killState:async()=>({snapshots:false,refine:false,sessions:false})}));
const directories:string[]=[],secret='FIXTURE_ONLY_NOT_A_REAL_SECRET_000000000000';
afterEach(()=>{resetSessionStorageForTests();clearSessions();resetRateWindows();vi.unstubAllEnvs();for(const dir of directories.splice(0)){if(dirname(dir)!==tmpdir())throw new Error('Unsafe fixture cleanup');rmSync(dir,{recursive:true,force:true});}});
function setup(){
  resetSessionStorageForTests();const dir=mkdtempSync(join(tmpdir(),'ordinary-sessions-'));directories.push(dir);const file=join(dir,'sessions.json');
  vi.stubEnv('WORLDSMITH_SESSION_STORE_FILE',file);vi.stubEnv('WORLDSMITH_OWNER_IDENTITY','trusted-proxy');vi.stubEnv('WORLDSMITH_OWNER_PROXY_SECRET',secret);vi.stubEnv('VERCEL',undefined);return file;
}
const request=(owner='alice',body?:unknown)=>new Request('http://fixture.invalid/api',{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),headers:{'x-worldsmith-owner':owner,'x-worldsmith-proxy-key':secret}});
const context=(id:string)=>({params:Promise.resolve({sessionId:id})});
function accepted(id:string,owner='alice'):StoredSession {
  const stored=openSession(id,DEMO_BLUEPRINT.sessionSeed,Date.now(),trustedCallerKey(request(owner))!)!;
  stored.session.advance('intent',{intent:DEMO_BLUEPRINT.intent});stored.blueprint=structuredClone(DEMO_BLUEPRINT);
  stored.session.advance('blueprint',{blueprint:stored.blueprint});stored.session.registerBlueprint(stored.blueprint);stored.session.advance('world',{title:'fixture'});return stored;
}
function comparison(stored:StoredSession){
  const original=structuredClone(stored.blueprint!.world);
  stored.blueprint={...stored.blueprint!,world:sealSimHash({...original,simRevision:original.simRevision+1})};
  const current=stored.blueprint.world;
  stored.comparisonOrigin={original,acceptedSimHash:current.simHash,acceptedSimRevision:current.simRevision,stableId:stored.blueprint.objects[0].stableId};
  stored.session.events.append('patch.committed',{fixture:true});
  return {simRevision:current.simRevision,lookRevision:current.lookRevision,simHash:current.simHash};
}
describe('durable ordinary sessions through actual host registry and routes',()=>{
  it('persists an accepted rule commit and refuses a later commit if disk ownership is lost',async()=>{
    const file=setup(),stored=accepted('ordinary-commit'),stableId='tallHive';
    const pending=(changeId:string,value:unknown)=>putChange(stored,{changeId,plan:{stableId,summary:'fixture rule',shape:null,addition:null,behavior:[{op:'replace',path:'/sim/rules/calmHive/condition',value}],appearance:[]},basedOn:{representation:stored.session.revisionOf(stableId)??0,sim:stored.blueprint!.world.simRevision,look:stored.blueprint!.world.lookRevision}});
    const call=(changeId:string)=>commit(new Request(request(),{method:'POST'}),{params:Promise.resolve({sessionId:stored.session.sessionId,changeId})});
    pending('first',null);expect((await call('first')).status).toBe(200);
    const revision=stored.blueprint!.world.simRevision,before=readFileSync(file,'utf8');pending('second',{kind:'hasItem',slot:0,item:'smoker'});
    const published=vi.fn();stored.session.events.subscribe(published);const lock=readFileSync(`${file}.lock`,'utf8');writeFileSync(`${file}.lock`,JSON.stringify({token:'lost-fixture-ownership'}));
    try{expect((await call('second')).status).toBe(503);expect(published).not.toHaveBeenCalled();expect(readFileSync(file,'utf8')).toBe(before);}finally{writeFileSync(`${file}.lock`,lock);}
    resetSessionStorageForTests();const recovered=getSession('ordinary-commit')!;expect(recovered.blueprint!.world.simRevision).toBe(revision);expect(recovered.changes.size).toBe(0);
  });
  it('restores three known owners, accepted revisions, comparison and reconnect snapshot exactly',async()=>{
    setup();const saved=['alice','bob','carol'].map(owner=>accepted(owner,owner));comparison(saved[0]);
    const blueprints=saved.map(s=>canonical(s.blueprint)),owners=saved.map(s=>s.owner),sequence=saved[0].session.events.sequence;
    resetSessionStorageForTests();
    for(let i=0;i<saved.length;i++) {
      const id=['alice','bob','carol'][i],response=await snapshot(request(id),context(id));expect(response.status).toBe(200);
      const recovered=await response.json();expect(canonical(recovered.blueprint)).toBe(blueprints[i]);expect(getSession(id)!.owner).toBe(owners[i]);
      expect(recovered.recovery).toMatchObject({kind:'restored',pendingChanges:'invalidated'});expect(getSession(id)!.changes.size).toBe(0);
    }
    expect(getSession('alice')!.session.events.sequence).toBe(sequence);expect(getSession('alice')!.comparisonOrigin).not.toBeNull();
    const expected=getSession('alice')!.blueprint!.world;
    const response=await restore(request('alice',{simRevision:expected.simRevision,lookRevision:expected.lookRevision,simHash:expected.simHash}),context('alice'));
    expect(response.status).toBe(200);const hash=(await response.json()).acceptedBlueprint.world.simHash;
    resetSessionStorageForTests();expect(getSession('alice')!.blueprint!.world.simHash).toBe(hash);expect(getSession('alice')!.blueprint!.world.simRevision).toBe(expected.simRevision+1);
  });
  it('records interrupted creation explicitly without reissuing any model work',()=>{
    setup();const stored=openSession('in-flight',DEMO_BLUEPRINT.sessionSeed,Date.now(),trustedCallerKey(request())!)!;
    stored.session.advance('intent',{fixture:true});const sequence=stored.session.events.sequence;
    resetSessionStorageForTests();const recovered=getSession('in-flight')!;
    expect(recovered.session.phase).toBe('failed');expect(recovered.fault).toContain('not repeated');expect(recovered.session.events.sequence).toBe(sequence+1);
    expect(recovered.session.events.all().at(-1)?.type).toBe('session.failed');
    resetSessionStorageForTests();expect(getSession('in-flight')!.session.events.sequence).toBe(sequence+1);
  });
  it('does not publish or acknowledge a revision when the durable write fails; further reads fail closed',async()=>{
    const file=setup(),stored=accepted('disk-failure');const body=comparison(stored),before=readFileSync(file,'utf8');
    const published=vi.fn();stored.session.events.subscribe(published);
    const lock=readFileSync(`${file}.lock`,'utf8');writeFileSync(`${file}.lock`,JSON.stringify({token:'lost-fixture-ownership'}));
    try {
      const result=await restore(request('alice',body),context('disk-failure'));expect(result.status).toBe(503);expect(published).not.toHaveBeenCalled();
      expect(readFileSync(file,'utf8')).toBe(before);expect((await snapshot(request(),context('disk-failure'))).status).toBe(503);
    }finally{writeFileSync(`${file}.lock`,lock);}
    resetSessionStorageForTests();expect(getSession('disk-failure')!.blueprint!.world.simRevision).toBe(body.simRevision);
  });
  it('retains bounded event backlog and tells a stale reconnect to fetch the authoritative snapshot',async()=>{
    setup();const stored=accepted('truncated');stored.session.events.beforePublish(null);
    for(let i=0;i<MAX_LOG_EVENTS+3;i++)stored.session.events.append('shape.queued',{i});
    putSession(stored);resetSessionStorageForTests();
    const recovered=getSession('truncated')!;expect(recovered.session.events.length).toBe(MAX_LOG_EVENTS);
    const response=await events(new Request('http://fixture.invalid/events?since=0'),context('truncated'));
    expect(response.status).toBe(409);expect((await response.json()).error.code).toBe('EVENT_HISTORY_TRUNCATED');
  });
  it('rejects a second writer and malformed durable files without accepting volatile sessions',async()=>{
    const file=setup();accepted('owned');expect(()=>openOrdinarySessionStore(file)).toThrow();resetSessionStorageForTests();
    writeFileSync(file,'broken-json');expect((await snapshot(request(),context('owned'))).status).toBe(503);
  });
});
