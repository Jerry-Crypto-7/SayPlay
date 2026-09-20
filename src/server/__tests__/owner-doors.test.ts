import {afterEach,describe,it,expect,vi} from 'vitest';
import {POST as edit} from '@/app/api/edit/route';
import {POST as generate} from '@/app/api/generate/route';
import {POST as emit} from '@/app/api/emit/route';
import {POST as stream} from '@/app/api/emit/stream/route';
import {POST as sessions} from '@/app/api/worldstream/sessions/route';
import {POST as changes} from '@/app/api/worldstream/sessions/[sessionId]/changes/route';
import {POST as commit} from '@/app/api/worldstream/sessions/[sessionId]/changes/[changeId]/commit/route';
import {POST as restore} from '@/app/api/worldstream/sessions/[sessionId]/comparison/restore/route';
import {handleSourceRequest} from '@/app/api/worldstream/source/handler';
vi.mock('@/server/kill-switch',()=>({killState:async()=>({sessions:false,generate:false,edit:false,emit:false,stream:false,changes:false,commit:false})}));
const context={params:Promise.resolve({sessionId:'missing',changeId:'missing'})};
afterEach(()=>vi.unstubAllEnvs());
describe('proxy identity is wired before mutable caller route work',()=>{
  const doors:readonly [string,(request:Request)=>Promise<Response>][]=[['edit',edit],['generate',generate],['emit',emit],['stream',stream],['sessions',sessions],
    ['changes',request=>changes(request,context)],['commit',request=>commit(request,context)],['restore',request=>restore(request,context)],['source',request=>handleSourceRequest(request)]];
  it.each(doors)('%s rejects forged owner before reading malformed body or starting work',async(_name,door)=>{
    vi.stubEnv('WORLDSMITH_OWNER_IDENTITY','trusted-proxy');vi.stubEnv('WORLDSMITH_OWNER_PROXY_SECRET','FIXTURE_ONLY_NOT_A_REAL_SECRET_000000000000');
    const request=new Request('http://fixture.invalid/api',{method:'POST',body:'not-json',headers:{'x-worldsmith-owner':'victim','x-worldsmith-proxy-key':'forged','x-forwarded-for':'victim'}});
    const response=await door(request);expect(response.status).toBe(403);expect((await response.json()).error.code).toBe('OWNER_IDENTITY_REQUIRED');
    expect(request.bodyUsed).toBe(false);
  });
});
