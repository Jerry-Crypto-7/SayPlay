/** Offline reproduction from a real archived live result; no emitter or HTTP. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {it,expect} from 'vitest';
import {worldDocSchema,canonical} from '@/ir/worlddoc';
import {routePatch} from '@/patch/router';
import {commitRoutedParts} from '@/app/api/edit/commit';
import {commitPart} from '@/ir/revision';
import {findDanglingReferences} from '@/ir/references';
import {buildRuntimeWorld} from '@/ir/build';
import {compareCommitCandidate} from '@/worldstream/accepted-branch';

it('reproduces a legitimate losing A4 future rejected only by the old winning witness',()=>{
 const root='plans/P20/live-browser-v2-20260917-1800';
 const original=worldDocSchema.parse(JSON.parse(readFileSync(`${root}/result.json`,'utf8')).snapshot.body.blueprint.world);
 const unchanged=canonical(original);
 const routing=routePatch({operations:[{op:'replace',path:'/sim/rules/activateSignal/actions/1/value',value:false}]},original);
 expect(routing.verdict).not.toBe('REJECTED');if(routing.verdict==='REJECTED')return;
 const patches=routing.patches.map(p=>({part:p.part,baseRevision:original.simRevision,operations:p.operations}));
 const classic=commitRoutedParts(original,patches);expect(classic.outcome).toBe('REJECTED');expect(classic.rejections.some(r=>r.stage==='witness')).toBe(true);
 const candidate=commitPart(original,patches[0]);expect(candidate.verdict).toBe('COMMITTED');if(candidate.verdict!=='COMMITTED')return;
 expect(findDanglingReferences(candidate.doc)).toEqual([]);expect(buildRuntimeWorld(candidate.doc.sim).ok).toBe(true);
 const input={base:{simRevision:original.simRevision,simHash:original.simHash,comparisonRevision:0,inputCount:1},inputs:[{tick:1,actor:'firstPerson',actionId:'activate',target:'computerTerminal'}],forkTick:0,observationTick:20};
 const comparison=compareCommitCandidate(original,candidate.doc,input);expect(comparison.verdict).toBe('COMPARED');
 expect(canonical(original)).toBe(unchanged);
 const evidence={provenance:'Offline diagnostic replay of actual archived live blueprint; no model/HTTP calls',operation:patches[0],classic,comparison,originalUnchanged:true};
 const file=`${root}/winning-gap-reproduction.json`;if(!existsSync(file))writeFileSync(file,JSON.stringify(evidence,null,2),{flag:'wx'});
 if(comparison.verdict==='COMPARED'){expect(comparison.snapshot.comparison!.original.runState).toBe('won');expect(comparison.snapshot.comparison!.changed.runState).toBe('running');}
});
