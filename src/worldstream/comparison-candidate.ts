import {commitPart,type PartPatch} from '@/ir/revision';
import type {WorldDoc} from '@/ir/worlddoc';
import {findDanglingReferences} from '@/ir/references';
import {buildRuntimeWorld} from '@/ir/build';
import {changedLeaves} from '@/patch/scope';
import {readAcceptedIntervention} from './intervention';

/** Private A4 candidate: typed, bounded and runnable, never a winning certificate.
 * Pure: callers store it only after comparison and authoritative revision checks. */
export function prepareComparisonCandidate(original:WorldDoc,patches:readonly PartPatch[]){
  const reject=(reason:string,detail:string)=>({ok:false as const,reason,detail});
  if(patches.length!==1||patches[0].part!=='sim')return reject('UNSUPPORTED_CHANGE','A comparison requires exactly one simulation patch and unchanged appearance.');
  const revised=commitPart(original,patches[0]);
  if(revised.verdict!=='COMMITTED')return reject(revised.reason,revised.detail);
  const scope=readAcceptedIntervention(original,revised.doc);
  if(!scope.ok)return reject('UNSUPPORTED_CHANGE',scope.detail);
  // The historic surface lowerer defaults flag values to true. A new private
  // comparison must not silently coerce an explicit non-boolean instruction.
  const booleanIssue = invalidBoolean(revised.doc.sim.rules);
  if(booleanIssue)return reject('INVALID_VALUE',booleanIssue);
  const dangling=findDanglingReferences(revised.doc);
  if(dangling.length)return reject('DANGLING_REFERENCE',`${dangling[0].where}: unknown ${dangling[0].name}`);
  const built=buildRuntimeWorld(revised.doc.sim);
  if(!built.ok)return reject(built.reason,built.issues.join('; '));
  return {ok:true as const,outcome:'COMPARISON_VALIDATED' as const,after:revised.doc,applied:['sim'] as const,
    changedLeaves:changedLeaves(original.sim,revised.doc.sim,'/sim'),certificate:null,rejections:[]};
}

function invalidBoolean(value:unknown):string|null {
  if(Array.isArray(value)){for(const item of value){const issue=invalidBoolean(item);if(issue)return issue;}return null;}
  if(value===null||typeof value!=='object')return null;
  const node=value as Record<string,unknown>;
  if((node.kind==='setFlag'||node.kind==='flagIs')&&node.value!==undefined&&typeof node.value!=='boolean')return `${node.kind}.value must be a boolean.`;
  for(const child of Object.values(node)){const issue=invalidBoolean(child);if(issue)return issue;}
  return null;
}
