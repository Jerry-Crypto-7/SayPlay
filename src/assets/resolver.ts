import type { PlannedObject } from '@/model/worldstream-intent';
import type { AssetManifest } from './manifest';

/** Candidates are suggestions, never substitutions. Unknown nouns retain their identity. */
export function representationCandidates(object: PlannedObject, manifest: AssetManifest) {
  const words = new Set([object.label, ...object.synonyms].join(' ').toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []);
  const candidates = manifest.candidates().map(asset => ({ asset,
    score: asset.tags.reduce((n, tag) => n + (words.has(tag.toLowerCase()) ? 1 : 0), 0),
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.asset.assetId.localeCompare(b.asset.assetId))
    .slice(0, 3).map(({ asset }) => ({
      source: { kind: 'asset' as const, assetId: asset.assetId, version: asset.version, hash: asset.hash },
      label: asset.label, tags: asset.tags, style: asset.style, bounds: asset.bounds,
      sockets: asset.sockets, parts: asset.parts, supportSurfaces: asset.supportSurfaces,
    }));
  return { stableId: object.stableId, status: candidates.length ? 'candidates' : 'cache-miss', candidates,
    alternatives: object.role === 'architecture' || object.role === 'terrain'
      ? ['parametric geometry'] : ['authored shape', 'generation request (not available synchronously)'] };
}
