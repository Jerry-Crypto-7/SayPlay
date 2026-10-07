import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { it } from 'vitest';
import { compileRecipe } from '../../../src/play/compose/compile';
import { arcadeWorldOf } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';

it('profiles unchanged verifier on synthetic assembled worlds', async () => {
  await loadRapier();
  const session = new Session(); session.connect();
  const post = (method: string) => new Promise<any>((resolve,reject) => session.post(method, (err,value) => err ? reject(err) : resolve(value)));
  const cases = [
    { move:'drive', kind:'chaser', content:{genre:'voyage',mode:'race',hero:'truck',setting:'desert'} },
    { move:'run', kind:'deliver', content:{genre:'runner',mode:'default',hero:'robot',setting:'forest'} },
  ] as const;
  const worlds = cases.map(c => {
    const spec = compileRecipe({preset:'assembled',move:c.move,actions:c.kind==='chaser'?[]:[c.kind],objective:'reach',threats:c.kind==='chaser'?['chaser']:[],content:c.content,parts:[{kind:c.kind,role:'part_0',label:c.kind==='chaser'?'bear':'parcel',phase:0,motion:'fall'}]});
    const built=arcadeWorldOf(spec,1); if(!built.ok)throw new Error(built.issues.join(';')); return built;
  });
  worlds.forEach(w=>verifyArcade(w.world,undefined,w.roleBindings));
  await post('Profiler.enable'); await post('Profiler.start');
  const runs=[];
  for(let round=0;round<3;round++)for(let i=0;i<worlds.length;i++){
    const w=worlds[i]!;const start=performance.now();const verdict=verifyArcade(w.world,undefined,w.roleBindings);
    const ms=performance.now()-start;
    const verdictHash=createHash('sha256').update(JSON.stringify(verdict,(_key,value)=>value instanceof Map?[...value]:value)).digest('hex');
    runs.push({round,move:cases[i]!.move,ms,tick:verdict.bot.tick,hash:verdict.bot.hash,verdictHash,publishEligible:verdict.publishEligible});
  }
  const {profile}=await post('Profiler.stop');session.disconnect();
  const counts=new Map<number,number>(); for(const id of profile.samples??[])counts.set(id,(counts.get(id)??0)+1);
  const hotspots=profile.nodes.map((n:any)=>({name:n.callFrame.functionName,file:n.callFrame.url,line:n.callFrame.lineNumber+1,samples:counts.get(n.id)??0})).sort((a:any,b:any)=>b.samples-a.samples);
  const phase=process.env.P42_PROFILE_PHASE??'cpu';
  if(!/^[a-z-]+$/.test(phase))throw new Error('invalid phase');
  writeFileSync(`evals/play/p42/profile-verify-${phase}.json`,JSON.stringify({runs,hotspots,profile},null,2),{flag:'wx'});
  console.log(JSON.stringify({runs,hotspots:hotspots.slice(0,25)}));
});
