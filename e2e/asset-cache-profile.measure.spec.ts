import {test,expect} from '@playwright/test';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import catalog from '../src/assets/catalog.json';

/** Renderer-only HTTP cache experiment. No route interception and no model. */
test('records GLB phase timings in a fresh context and same-context reload',async({page},info)=>{
  test.skip(process.env.P20_ASSET_PROFILE!=='1','Explicit P20_ASSET_PROFILE=1 required');test.setTimeout(120_000);
  const folder=process.env.P20_ASSET_PROFILE_DIR;
  if(!folder||existsSync(folder))throw new Error('P20_ASSET_PROFILE_DIR must name a new output directory');
  mkdirSync(folder,{recursive:true});
  const errors:string[]=[],rows:unknown[]=[];page.on('pageerror',e=>errors.push(e.message));
  const asset=catalog.assets.find(a=>a.assetId==='seated-person')!;
  const save=()=>writeFileSync(join(folder,'results.json'),JSON.stringify({version:'p20-asset-cache-profile-v1',rows,errors,
    provenance:'Manual renderer fixture, not prompt/model/G-L or external provider evidence.',
    cache:'First navigation uses a fresh Playwright context. Second reload reuses browser HTTP cache but creates a new JS loader and decoded cache; cache outcome is observed, not assumed.',
    gpuUploadMs:null,gpuNote:'No GPU upload duration measured. Renderer memory counters are not byte/time measurements.',
    serverCacheState:'unknown',navigations:rows.length,maxNavigations:2,project:info.project.name,
    sourceHashes:Object.fromEntries(['src/assets/loader.ts','src/assets/cache.ts','src/components/viewer/WorldstreamStage.tsx','src/assets/catalog.json'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))},null,2));
  try{
    for(const phase of ['fresh-context','same-context-reload'] as const){
      const start=Date.now();if(phase==='fresh-context')await page.goto('/dev/asset-hot-swap');else await page.reload();
      await expect.poll(()=>page.evaluate(hash=>{const slots=window.__worldstreamStage?.slots()??[];return slots.length===5&&slots.every(s=>s.contentHash===hash&&!s.failure);},asset.lods[0].hash),{timeout:30_000}).toBe(true);
      const data=await page.evaluate(()=>{
        const stage=window.__worldstreamStage!;
        const resources=(performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(r=>new URL(r.name).pathname.endsWith('.glb')).map(r=>({
          url:r.name,initiatorType:r.initiatorType,startTime:r.startTime,duration:r.duration,fetchStart:r.fetchStart,
          requestStart:r.requestStart,responseStart:r.responseStart,responseEnd:r.responseEnd,
          transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize,
          deliveryType:(r as PerformanceResourceTiming&{deliveryType?:string}).deliveryType??null,
          cacheEvidence:r.transferSize===0&&r.decodedBodySize>0?'zero-transfer cached response':r.transferSize>0?'network transfer or revalidation':'unknown',
        }));
        return {loads:stage.assetLoads(),resources,memory:stage.memory(),streaming:stage.streaming(),slots:stage.slots().map(s=>({stableId:s.stableId,objectId:s.objectId,hash:s.contentHash,triangles:s.triangles})),
          frames:stage.frames(),environment:{userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight}};
      });
      rows.push({phase,readyMs:Date.now()-start,...data});save();
      expect(data.loads.filter(l=>l.status==='loaded')).toHaveLength(1);expect(data.resources).toHaveLength(1);
      expect(new Set(data.slots.map(s=>s.objectId)).size).toBe(5);
      expect(data.loads[0].phases.decode).not.toBeNull();
      await page.screenshot({path:join(folder,`${phase}.png`)});
    }
    expect(errors).toEqual([]);
  }finally{save();}
});
