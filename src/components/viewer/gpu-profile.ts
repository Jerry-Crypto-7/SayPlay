import type { WebGLRenderer } from 'three';

export interface RenderTiming {
  status:'complete'|'unsupported'|'timeout'|'disjoint'|'disposed'|'busy';
  gpuMs:number[];
  cpuSubmitMs:number[];
  scope:'renderer.render including shadow passes; CPU submission excludes simulation; contexts measured separately';
}
const scope:RenderTiming['scope']='renderer.render including shadow passes; CPU submission excludes simulation; contexts measured separately';
interface TimerExtension {TIME_ELAPSED_EXT:number;GPU_DISJOINT_EXT:number}

/** Opt-in, bounded measurement. Never waits synchronously for the GPU. */
export function createRenderProfiler(renderer:WebGLRenderer) {
  const gl=renderer.getContext() as WebGL2RenderingContext;
  let disposed=false;
  let stop:((status:RenderTiming['status'])=>void)|null=null;
  return {
    measure(count=60):Promise<RenderTiming> {
      if(!Number.isInteger(count)||count<1||count>180)throw new Error('Render profile sample count must be 1–180');
      const empty=(status:RenderTiming['status'])=>Promise.resolve({status,gpuMs:[],cpuSubmitMs:[],scope});
      if(disposed)return empty('disposed');
      if(stop)return empty('busy');
      const extension=gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension|null;
      if(!extension)return empty('unsupported');
      return new Promise(resolve=>{
        const gpuMs:number[]=[],cpuSubmitMs:number[]=[];
        const original=renderer.render;
        let pending:WebGLQuery|null=null,ended=false;
        const finish=(status:RenderTiming['status'])=>{
          if(ended)return;ended=true;clearTimeout(deadline);
          if(renderer.render===wrapped)renderer.render=original;
          if(pending)gl.deleteQuery(pending);
          pending=null;stop=null;
          // Disjoint invalidates the whole measurement, not just its last query.
          resolve({status,gpuMs:status==='disjoint'?[]:gpuMs,cpuSubmitMs,scope});
        };
        const wrapped:WebGLRenderer['render']=function(scene,camera) {
          if(gl.getParameter(extension.GPU_DISJOINT_EXT)){finish('disjoint');return original.call(renderer,scene,camera);}
          if(pending&&gl.getQueryParameter(pending,gl.QUERY_RESULT_AVAILABLE)) {
            const nanoseconds=gl.getQueryParameter(pending,gl.QUERY_RESULT) as number;
            gl.deleteQuery(pending);pending=null;
            if(Number.isFinite(nanoseconds)&&nanoseconds>=0)gpuMs.push(nanoseconds/1e6);
            if(gpuMs.length>=count){finish('complete');return original.call(renderer,scene,camera);}
          }
          // Do not interfere with an independently active timer query.
          const query=!pending&&!gl.getQuery(extension.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)?gl.createQuery():null;
          if(query)gl.beginQuery(extension.TIME_ELAPSED_EXT,query);
          const started=performance.now();
          try { original.call(renderer,scene,camera); }
          finally {
            if(query){cpuSubmitMs.push(performance.now()-started);gl.endQuery(extension.TIME_ELAPSED_EXT);pending=query;}
          }
        };
        const deadline=setTimeout(()=>finish('timeout'),30_000);
        stop=finish;renderer.render=wrapped;
      });
    },
    dispose(){disposed=true;stop?.('disposed');},
  };
}
