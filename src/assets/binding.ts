import type { SemanticObject } from '@/worldstream/schema';
import type { AssetRecord } from './schema';
import { fitAsset } from './manifest';
import {transformPoint,transformNormal,transformBounds} from './transform';

/** Kontrola importovaného modelu proti pevnému kontraktu objektu. */
export function assetObjectIssues(object: SemanticObject, asset: AssetRecord): string[] {
  const issues: string[] = [];
  let transform: ReturnType<typeof fitAsset>;
  try { transform = fitAsset(asset, object.targetBounds, object.stretchAxes, object.yaw); }
  catch (error) { return [String(error)]; }
  for (const part of object.binding?.parts ?? []) {
    const imported = asset.parts.find(candidate => candidate.id === part.id);
    if (!imported || part.sockets.some(id => !imported.sockets.includes(id)))
      issues.push(`Asset does not implement part ${part.id} and its sockets`);
  }
  for (const socket of object.binding?.sockets ?? []) {
    const imported = asset.sockets.find(candidate => candidate.id === socket.id);
    if (!imported) {
      issues.push(`Asset does not implement socket ${socket.id}`);
      continue;
    }
    const normal = transformNormal(transform,imported.normal);
    const point = transformPoint(transform,imported.at);
    if (point.some((value, axis) => Math.abs(value - socket.at[axis]) > 0.0001)
      || normal.some((value, axis) => Math.abs(value - socket.normal[axis]) > 0.0001))
      issues.push(`Asset socket ${socket.id} does not match the accepted world binding`);
  }
  if (object.yaw !== undefined && object.binding) for (const collision of asset.collision) {
    const local=collision.kind==='box'?collision.bounds:{min:collision.center.map(v=>v-collision.radius) as [number,number,number],max:collision.center.map(v=>v+collision.radius) as [number,number,number]};
    const fitted=transformBounds(transform,local),accepted=object.binding.collider;
    if ([0,1,2].some(axis=>fitted.min[axis]<accepted.min[axis]-0.0001 || fitted.max[axis]>accepted.max[axis]+0.0001))
      issues.push('Rotated asset collision exceeds the accepted world collider');
  }
  return issues;
}
