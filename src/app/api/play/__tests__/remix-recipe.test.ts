import { beforeEach, describe, expect, it, vi } from 'vitest';
import { essentialTriples } from '@/play/intent/contract';

const mocks=vi.hoisted(()=>({
  get:vi.fn(), verified:vi.fn(), honesty:vi.fn(), sentence:vi.fn(), publish:vi.fn(), start:vi.fn(), status:vi.fn(), read:vi.fn(), patch:vi.fn(), apply:vi.fn(), compiler:vi.fn(),
}));
vi.mock('@/play/director/remix',()=>({REMIX_CHIPS:['harder','twist','swap_enemy','reskin'],verifiedRecipeRemixes:mocks.verified,chipOf:(s:string)=>s==='Make it harder'?'harder':null,remixPatch:mocks.patch,applyRemix:mocks.apply}));
vi.mock('@/play/draft/unsupported',()=>({honestyOf:mocks.honesty,sentenceOf:mocks.sentence}));
vi.mock('../_compiler',()=>({getCompiler:()=>mocks.compiler}));
vi.mock('../_report',()=>({reportFor:()=>({publishEligible:true})}));
vi.mock('../_errors',()=>({
  VERSION_ID_PATTERN:/^[a-f0-9]{64}$/,
  notFound:()=>Response.json({code:'NOT_FOUND'},{status:404}),
  fail:(status:number,code:string,message:string)=>Response.json({code,message},{status}),
  refuseSentence:()=>null,
  readJsonBody:async(request:Request)=>({ok:true,value:await request.json()}),
}));
vi.mock('../_publish',()=>({
  admit:async()=>null,store:()=>({get:mocks.get}),isSeed:(s:unknown)=>Number.isInteger(s)&&Number(s)>0&&Number(s)<2**31,
  seedFrom:()=>91,derivedSeeds:(seed:number)=>[seed,seed+1],directorCallerOf:()=> 'test',publishRefusal:async()=>null,
  publishReadSpec:mocks.publish,readSpecOrFail:mocks.read,
  publishedResponse:(value:{status:number;game:{version:{versionId:string;parentId:string;seed:number}}})=>Response.json({...value.game.version},{status:value.status}),
}));
vi.mock('../_remix-jobs',()=>({cleanRemixSentence:(s:string)=>s.trim(),startRemix:mocks.start,remixStatus:mocks.status}));
import { GET, POST } from '../games/[id]/remix/route';

const parentId='a'.repeat(64), childId='b'.repeat(64);
const source={schema:'gamespec.v1',title:'stored parent',roles:[{id:'player',kind:'player',label:'fox',count:1}]};
const child={...source,title:'verified child',addons:['shoot']};
const parent={spec:source,version:{versionId:parentId,parentId:null,seed:37},origin:{sentence:'A fox runs and shoots robots'}};
const candidate={id:'make-race',label:'Make it a race',cellId:'live-drive-race-shoot',spec:child,ops:[{op:'add',path:'/addons',value:['shoot']}]};
const context=(id=parentId)=>({params:Promise.resolve({id})});
const post=(body:unknown)=>POST(new Request(`http://play.test/api/play/games/${parentId}/remix`,{method:'POST',body:JSON.stringify(body)}),context());
const get=(query='suggestions=1',id=parentId)=>GET(new Request(`http://play.test/api/play/games/${id}/remix?${query}`),context(id));
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(parent);mocks.sentence.mockResolvedValue(parent.origin.sentence);mocks.honesty.mockResolvedValue(null);
  mocks.verified.mockImplementation(async(_spec,_seed,options)=>options.unmet.length?[]:[candidate]);
  mocks.publish.mockImplementation(async(_store,_spec,seeds,id)=>({ok:true,value:{status:201,game:{version:{versionId:childId,parentId:id,seed:seeds[0]}}}}));
  mocks.start.mockReturnValue({status:'pending',job:'c'.repeat(32)});mocks.status.mockResolvedValue({status:'ready',versionId:childId});
  mocks.read.mockImplementation(spec=>({ok:true,value:spec}));mocks.patch.mockReturnValue([{op:'replace',path:'/title',value:'harder'}]);mocks.apply.mockReturnValue({ok:true,spec:child});
});

describe('verified recipe remix route',()=>{
  it('GET exposes summaries only and verifies the stored spec, seed, full intent and honesty',async()=>{
    const result=await get();expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({suggestions:[{id:candidate.id,label:candidate.label,cellId:candidate.cellId}]});
    expect(mocks.sentence).toHaveBeenCalledWith(expect.objectContaining({get:mocks.get}),parent);
    expect(mocks.honesty).toHaveBeenCalledWith(expect.objectContaining({get:mocks.get}),parent);
    const [spec,seed,options]=mocks.verified.mock.calls[0]!;expect(spec).toBe(source);expect(seed).toBe(37);expect(options.unmet).toEqual([]);
    expect(essentialTriples(options.intent)).toEqual(expect.arrayContaining([expect.objectContaining({actor:'fox',verb:'run'}),expect.objectContaining({actor:'fox',verb:'shoot',object:'robot'})]));
    expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
  });
  it('POST re-verifies and publishes only that server candidate at exactly the checked seed',async()=>{
    await get();const result=await post({sentence:'Make it a race'});expect(result.status).toBe(201);
    expect(mocks.verified).toHaveBeenCalledTimes(2);expect(mocks.publish).toHaveBeenCalledWith(expect.anything(),child,[37],parentId);
    expect(mocks.start).not.toHaveBeenCalled();expect(mocks.compiler).not.toHaveBeenCalled();
    mocks.publish.mockResolvedValueOnce({ok:true,value:{status:200,game:{version:{versionId:childId,parentId:parentId,seed:37}}}});
    const repeated=await post({sentence:'Make it a race',seed:37});expect(repeated.status).toBe(200);expect((await repeated.json()).versionId).toBe(childId);
    expect(mocks.publish.mock.calls.at(-1)?.[2]).toEqual([37]);
  });
  it('never uses a client spec or different seed to prove an advertised chip',async()=>{
    expect((await post({sentence:'Make it a race',spec:{title:'forged'}})).status).toBe(400);
    expect((await post({sentence:'Make it a race',seed:99})).status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.verified).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
  });
  it('a stale chip is rejected rather than silently sent to a model',async()=>{
    await get();mocks.verified.mockResolvedValueOnce([]);
    const result=await post({sentence:'Make it a race'});expect(result.status).toBe(422);
    expect(mocks.verified).toHaveBeenCalledTimes(2);expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
  });
  it('forwards every unmet triple and suppresses both GET and POST choices',async()=>{
    const unmet=[{actor:'fox',verb:'sing',object:null}];mocks.honesty.mockResolvedValue({kind:'actions',unmet});
    expect(await (await get()).json()).toEqual({suggestions:[]});expect((await post({sentence:'Add shooting'})).status).toBe(422);
    expect(mocks.verified.mock.calls[0]?.[2].unmet).toEqual(unmet);expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
  });
  it('supports authored parents without sentence by preserving the helper fallback contract',async()=>{
    mocks.sentence.mockResolvedValue(null);await get();expect(mocks.verified.mock.calls[0]?.[2]).toEqual({unmet:[]});
  });
  it('retains legacy chip, free text, explicit spec and job polling paths',async()=>{
    expect((await post({chip:'harder'})).status).toBe(201);expect(mocks.patch).toHaveBeenCalled();
    expect((await post({sentence:'add snow'})).status).toBe(202);expect(mocks.start).toHaveBeenCalledOnce();
    expect((await post({spec:child,seed:19})).status).toBe(201);expect(mocks.publish.mock.calls.at(-1)?.[2]).toEqual([19]);
    expect(await (await get(`job=${'c'.repeat(32)}`)).json()).toEqual({status:'ready',versionId:childId});
    expect(mocks.verified).not.toHaveBeenCalled();
  });
  it('rejects missing parents and bad ids without verification',async()=>{
    expect((await get('suggestions=1','bad-id')).status).toBe(404);mocks.get.mockResolvedValue(null);expect((await get()).status).toBe(404);
    expect((await post({sentence:'Add shooting'})).status).toBe(404);expect(mocks.verified).not.toHaveBeenCalled();
  });
});
