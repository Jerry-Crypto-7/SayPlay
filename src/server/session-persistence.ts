import type {StoredSession} from '@/worldstream/sessions';
import {restoreSession} from '@/worldstream/session';
import {shareWorld} from '@/worldstream/snapshot-store';
import {ordinarySessionRecordSchema,SessionStoreError,type OrdinarySessionStore} from './session-store';

export const RESTARTED_SESSION_FAULT='Generation was interrupted by a server restart. Start a new request; the previous model call was not repeated.';
/** A persistence barrier, not an SSE subscriber. Failure poisons the host adapter. */
export function createSessionPersistence(live:Map<string,StoredSession>,store:OrdinarySessionStore) {
  let poisoned=false,version=0,closed=false;
  const healthy=()=>{if(poisoned||closed)throw new SessionStoreError();};
  const flush=()=>{
    healthy();try {
      const records=[...live.values()].map(stored=>ordinarySessionRecordSchema.parse({
        owner:stored.owner,snapshot:stored.session.snapshot(),blueprint:stored.blueprint,
        comparisonOrigin:stored.comparisonOrigin??null,authoredWorldId:stored.authoredWorldId,
        fault:stored.fault,eventLog:stored.session.events.checkpoint(),updatedAt:Date.now(),
      }));
      version=store.save(records,version);
    }catch{poisoned=true;throw new SessionStoreError();}
  };
  const bind=(stored:StoredSession)=>stored.session.events.beforePublish(flush);
  try {
    const loaded=store.load();version=loaded.version;
    if(live.size)throw new SessionStoreError();
    for(const record of loaded.records) {
      const session=restoreSession(record.snapshot,{eventLog:record.eventLog});
      const interrupted=!record.blueprint||!['world','complete','failed'].includes(record.snapshot.phase);
      const stored:StoredSession={session,owner:record.owner,blueprint:record.blueprint,comparisonOrigin:record.comparisonOrigin,
        authoredWorldId:record.authoredWorldId,fault:record.fault,sharedWorld:record.blueprint?shareWorld(record.blueprint,Date.now()):null,changes:new Map(),
        recovery:{kind:interrupted?'interrupted':'restored',pendingChanges:'invalidated',sourceProjects:'not-restored'}};
      if(interrupted&&session.phase!=='failed') {
        // No emitter/promise/job resumes. This failure is recorded before exposure.
        stored.fault=RESTARTED_SESSION_FAULT;
        if(session.phase==='complete') {
          stored.session.events.append('session.failed',{reason:RESTARTED_SESSION_FAULT});
          const failed={...session.snapshot(),phase:'failed' as const};
          (stored as {session:typeof session}).session=restoreSession(failed,{eventLog:session.events.checkpoint()});
        } else session.fail(RESTARTED_SESSION_FAULT);
      }
      live.set(session.sessionId,stored);
    }
    if(loaded.records.length)flush();
    for(const stored of live.values())bind(stored);
  }catch{poisoned=true;throw new SessionStoreError();}
  return {healthy,flush,bind,close(){if(closed)return;closed=true;for(const stored of live.values())stored.session.events.beforePublish(null);store.close();}};
}

export function sessionStoreUnavailable():Response {
  return Response.json({error:{code:'SESSION_STORAGE_UNAVAILABLE',message:'Durable session storage is unavailable.'}},{status:503,headers:{'cache-control':'no-store'}});
}
/** Route wrapper converts storage faults only; unrelated bugs retain their diagnostics. */
export async function withSessionStorageResponse(work:()=>Promise<Response>):Promise<Response> {
  try{return await work();}catch(error){if(error instanceof SessionStoreError)return sessionStoreUnavailable();throw error;}
}
