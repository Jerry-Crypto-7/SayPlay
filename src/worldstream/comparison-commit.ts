import type {WorldDoc} from '@/ir/worlddoc';
import type {PartPatch} from '@/ir/revision';
import {prepareComparisonCandidate} from './comparison-candidate';
import {compareCommitCandidate} from './accepted-branch';
export function prepareComparisonCommit(original:WorldDoc,patches:readonly PartPatch[],request:unknown){
  const candidate=prepareComparisonCandidate(original,patches);if(!candidate.ok)return candidate;
  const compared=compareCommitCandidate(original,candidate.after,request);
  if(compared.verdict!=='COMPARED')return {ok:false as const,reason:compared.reason,detail:compared.detail};
  return {...candidate,comparison:compared.snapshot.comparison!};
}
