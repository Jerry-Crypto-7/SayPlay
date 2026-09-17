import { canonicalHash } from '@/ir/worlddoc';
import { assessShapeDetail } from './detail-policy';
import { certainHulls, reachableFrom, type Bounds3, type ShapeNode, type ShapeProgram, type Vec3 } from './types';

export interface RepeatInstances {
  readonly sourceHash:string;
  readonly unitBounds:Bounds3;
  readonly offsets:readonly Vec3[];
}
export type RepeatPlan = {kind:'unchanged'} | {kind:'unsupported';reason:string} |
  {kind:'repeat-instanced';program:ShapeProgram;instances:RepeatInstances};

/** Only disjoint, bounded, hard-union units. certainHulls alone is NOT an upper
 * bound: union ignores unknown children. Check every reachable node first. */
export function planRootRepeat(program:ShapeProgram,resolution:number,preserveInstances=false):RepeatPlan {
  if(!preserveInstances&&assessShapeDetail(program,resolution).status!=='sampling-risk')return {kind:'unchanged'};
  const root=program.nodes[program.root];
  const unsupported=(reason:string):RepeatPlan=>({kind:'unsupported',reason});
  if(root.kind!=='repeat')return unsupported('Sampling risk: only a disjoint root repeat can be instanced automatically.');
  if(root.count<2||root.count>32)return unsupported('Repeat count is outside the bounded 2–32 instance policy.');
  const indices=[...reachableFrom(program.nodes,root.child)].sort((a,b)=>a-b);
  const allowed=new Set(['sphere','box','roundBox','capsule','cylinder','cone','torus','ellipsoid','prism','translate','scale','union']);
  for(const index of indices){
    const node=program.nodes[index];
    if(!allowed.has(node.kind)||(node.kind==='union'&&!!node.k))return unsupported(`Unit node ${index} (${node.kind}) has no supported conservative sampling bound.`);
  }
  const hull=certainHulls(program.nodes)[root.child];
  if(!hull||hull.max.some((v,i)=>!Number.isFinite(v)||v<=hull.min[i]))return unsupported('Unit has no finite nondegenerate bound.');
  // One separating axis suffices for every translated pair. Leave at least two
  // unit-grid cells between copies so independently closed meshes do not touch.
  const gap=2*Math.max(...hull.max.map((v,i)=>v-hull.min[i]))/resolution;
  if(!root.step.some((step,axis)=>Math.abs(step)>hull.max[axis]-hull.min[axis]+gap))return unsupported('Repeat copies overlap or lack a safe sampling gap.');
  const offsets=Array.from({length:root.count},(_,i):Vec3=>[i*root.step[0],i*root.step[1],i*root.step[2]]);
  if(offsets.some(offset=>hull.min.some((v,i)=>v+offset[i]<program.targetBounds.min[i]-1e-6)||hull.max.some((v,i)=>v+offset[i]>program.targetBounds.max[i]+1e-6)))
    return unsupported('Repeated units extend outside the original sampling bounds.');
  const remap=new Map(indices.map((index,i)=>[index,i]));
  const nodes=indices.map(index=>{
    const node=program.nodes[index];
    return 'children' in node?{...node,children:node.children.map(child=>remap.get(child)!)}:
      'child' in node?{...node,child:remap.get(node.child)!}:node;
  }) as ShapeNode[];
  const unit={...program,nodes,root:remap.get(root.child)!,targetBounds:hull,anchors:[]};
  if(assessShapeDetail(unit,resolution).maxVoxelMeters>=assessShapeDetail(program,resolution).maxVoxelMeters)
    return unsupported('Unit sampling does not improve the feature-relative grid.');
  return {kind:'repeat-instanced',program:unit,instances:{sourceHash:canonicalHash(program),unitBounds:hull,offsets}};
}

export function repeatedBounds(bounds:Bounds3,instances:RepeatInstances):Bounds3 {
  const min=(axis:number)=>Math.min(...instances.offsets.map(offset=>bounds.min[axis]+offset[axis]));
  const max=(axis:number)=>Math.max(...instances.offsets.map(offset=>bounds.max[axis]+offset[axis]));
  return {min:[min(0),min(1),min(2)],max:[max(0),max(1),max(2)]};
}
