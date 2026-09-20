import type { PlannedObject } from './worldstream-intent';
import type { AssetManifest } from '@/assets/manifest';
import { representationCandidates } from '@/assets/resolver';

/** One dictionary entry per immutable asset, regardless of instance count.
 * The shortlist is advisory; unknown objects retain the authored alternatives. */
export function buildAssetBrief(objects: readonly PlannedObject[], manifest: AssetManifest) {
  const assets: Record<string, ReturnType<typeof representationCandidates>['candidates'][number]> = {};
  const selections = objects.map(object => {
    const { candidates, ...selection } = representationCandidates(object, manifest);
    return { ...selection, candidates: candidates.map(candidate => {
      const key = `${candidate.source.assetId}@${candidate.source.version}`;
      assets[key] = candidate;
      return key;
    }) };
  });
  return { objects: selections, assets };
}
