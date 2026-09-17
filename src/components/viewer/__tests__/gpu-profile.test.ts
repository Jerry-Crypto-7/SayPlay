import {describe,it,expect,vi} from 'vitest';
import type {WebGLRenderer} from 'three';
import {createRenderProfiler} from '../gpu-profile';

function fixture(supported=true) {
  let disjoint=false;
  const gl={QUERY_RESULT_AVAILABLE:1,QUERY_RESULT:2,CURRENT_QUERY:3,
    getExtension:()=>supported?{TIME_ELAPSED_EXT:4,GPU_DISJOINT_EXT:5}:null,
    getParameter:()=>disjoint,getQueryParameter:(_q:unknown,key:number)=>key===1?true:2_500_000,
    getQuery:()=>null,createQuery:()=>({}),deleteQuery:vi.fn(),beginQuery:vi.fn(),endQuery:vi.fn()};
  const original=vi.fn();
  const renderer={getContext:()=>gl,render:original} as unknown as WebGLRenderer;
  return {renderer,original,gl,disjoint:()=>{disjoint=true;}};
}
describe('opt-in GPU profiling',()=>{
  it('collects asynchronous GPU results, bounds samples and restores renderer',async()=>{
    const f=fixture(),p=createRenderProfiler(f.renderer),result=p.measure(2);
    expect((await p.measure()).status).toBe('busy');
    for(let i=0;i<3;i++)f.renderer.render(null!,null!);
    expect(await result).toMatchObject({status:'complete',gpuMs:[2.5,2.5]});
    expect(f.gl.beginQuery).toHaveBeenCalledTimes(2);expect(f.gl.endQuery).toHaveBeenCalledTimes(2);
    expect(f.original).toHaveBeenCalledTimes(3);expect(f.renderer.render).toBe(f.original);
    expect(()=>p.measure(181)).toThrow();p.dispose();
  });
  it('does not replace renderer when timers are unavailable',async()=>{
    const f=fixture(false),p=createRenderProfiler(f.renderer);
    expect((await p.measure()).status).toBe('unsupported');expect(f.renderer.render).toBe(f.original);
  });
  it('invalidates disjoint samples and disposes pending queries',async()=>{
    const f=fixture(),p=createRenderProfiler(f.renderer),result=p.measure(2);
    f.renderer.render(null!,null!);f.disjoint();f.renderer.render(null!,null!);
    expect(await result).toMatchObject({status:'disjoint',gpuMs:[]});expect(f.gl.deleteQuery).toHaveBeenCalledOnce();
    const g=fixture(),q=createRenderProfiler(g.renderer),pending=q.measure();g.renderer.render(null!,null!);q.dispose();
    expect((await pending).status).toBe('disposed');expect(g.renderer.render).toBe(g.original);expect(g.gl.deleteQuery).toHaveBeenCalledOnce();
  });
});
