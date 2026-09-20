import type { Bounds3 } from '@/shape/types';
import type { SceneSpec } from './spec';
import type {Vec3} from '@/shape/types';
import type {SurfaceSample} from './contact';

export interface LayoutBody {
  readonly stableId: string;
  readonly bounds: Bounds3;
  /** Normalized asset forward; absent for shapes without a authored frame. */
  readonly forward?: readonly [number, number, number];
  readonly supports?: readonly Bounds3[];
  /** Only a catalog door with an explicit runtime entity binding. */
  readonly passageClosure?: 'bound-door';
  /** Architecture envelope includes empty rooms; passage checks need occupied slabs. */
  readonly occupiedBounds?: readonly Bounds3[];
  readonly contact?: {readonly at:Vec3;readonly normal:Vec3};
  readonly sampleGround?: (x:number,z:number)=>SurfaceSample|null;
  readonly supportsAt?: (point:Vec3)=>boolean;
}
export interface Passage { readonly owner: string; readonly min: readonly number[]; readonly max: readonly number[] }
export interface LayoutIssue { readonly kind: 'unsatisfied' | 'unsupported'; readonly subjectId: string; readonly detail: string }
const tolerance = 0.08;
const overlap = (a: Bounds3, b: Bounds3, axis: number) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]);
const gap = (a: Bounds3, b: Bounds3, axis: number) => Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);

/** Conservative AABB spatial checks. No implied navigation/terrain/contact proof. */
export function validateLayout(spec: SceneSpec | undefined, bodies: readonly LayoutBody[], passages: readonly Passage[] = []): LayoutIssue[] {
  const byId = new Map(bodies.map((b) => [b.stableId, b]));
  const issues: LayoutIssue[] = [];
  for (const relation of spec?.relations ?? []) {
    const a = byId.get(relation.subjectId), b = byId.get(relation.targetId);
    const fail = (kind: LayoutIssue['kind'], detail: string) => issues.push({ kind, subjectId: relation.subjectId, detail: `${relation.relation} ${relation.targetId}: ${detail}` });
    if (!a || !b) { fail('unsupported', 'missing measurable representation'); continue; }
    if (relation.relation === 'inside') {
      if ([0,1,2].some((axis) => a.bounds.min[axis] < b.bounds.min[axis]-tolerance || a.bounds.max[axis] > b.bounds.max[axis]+tolerance)) fail('unsatisfied', 'subject extends outside enclosing bounds');
    } else if (relation.relation === 'near') {
      if (Math.hypot(...[0,1,2].map((axis) => gap(a.bounds,b.bounds,axis))) > 2) fail('unsatisfied', 'surface distance exceeds 2 meters');
    } else if (relation.relation === 'on') {
      if(b.sampleGround) {
        if(a.contact&&a.contact.normal[1]>-0.5){fail('unsatisfied','support contact normal does not face downward');continue;}
        const at=a.contact?.at??[(a.bounds.min[0]+a.bounds.max[0])/2,a.bounds.min[1],(a.bounds.min[2]+a.bounds.max[2])/2];
        const sample=b.sampleGround(at[0],at[2]);
        if(!sample)fail('unsatisfied','contact lies outside the actual terrain surface');
        else if(Math.abs(at[1]-sample.height)>tolerance)fail('unsatisfied',`contact height ${at[1].toFixed(3)} differs from terrain ${sample.height.toFixed(3)}`);
        else if(!a.contact && [a.bounds.min[0],a.bounds.max[0]].some(x=>[a.bounds.min[2],a.bounds.max[2]].some(z=>(b.sampleGround!(x,z)?.height??-Infinity)>a.bounds.min[1]+tolerance)))fail('unsatisfied','rigid footprint intersects uneven terrain; explicit contact anchors or smaller support required');
        continue;
      }
      if (!b.supports?.length) { fail('unsupported', 'target has no declared support surface; bounds are not a seat or terrain surface'); continue; }
      if(a.contact) {
        if(a.contact.normal[1]>-0.5)fail('unsatisfied','support contact normal does not face downward');
        else if(b.supportsAt ? !b.supportsAt(a.contact.at) : !b.supports.some(s=>Math.abs(a.contact!.at[1]-s.max[1])<=tolerance&&a.contact!.at[0]>=s.min[0]-tolerance&&a.contact!.at[0]<=s.max[0]+tolerance&&a.contact!.at[2]>=s.min[2]-tolerance&&a.contact!.at[2]<=s.max[2]+tolerance))fail('unsatisfied','accepted contact socket does not rest on a declared support surface');
        continue;
      }
      if(b.supportsAt) {
        if(![a.bounds.min[0],a.bounds.max[0]].every(x=>[a.bounds.min[2],a.bounds.max[2]].every(z=>b.supportsAt!([x,a.bounds.min[1],z]))))fail('unsatisfied','base footprint extends outside the oriented support surface');
        continue;
      }
      if (!b.supports.some((s) => Math.abs(a.bounds.min[1]-s.max[1]) <= tolerance && a.bounds.min[0] >= s.min[0]-tolerance && a.bounds.max[0] <= s.max[0]+tolerance && a.bounds.min[2] >= s.min[2]-tolerance && a.bounds.max[2] <= s.max[2]+tolerance)) fail('unsatisfied', 'base does not rest inside a declared support surface');
    } else if (relation.relation === 'facing') {
      if (!a.forward) { fail('unsupported', 'representation has no declared forward direction'); continue; }
      const dx = (b.bounds.min[0]+b.bounds.max[0]-a.bounds.min[0]-a.bounds.max[0])/2;
      const dz = (b.bounds.min[2]+b.bounds.max[2]-a.bounds.min[2]-a.bounds.max[2])/2;
      const distance = Math.hypot(dx,dz);
      if (distance < tolerance || (a.forward[0]*dx+a.forward[2]*dz)/distance < 0.707) fail('unsatisfied', 'target is outside the forward 90 degree cone');
    } else {
      const touching = [0,1,2].some((axis) => Math.min(Math.abs(a.bounds.min[axis]-b.bounds.max[axis]),Math.abs(a.bounds.max[axis]-b.bounds.min[axis])) <= tolerance && [0,1,2].filter((i) => i !== axis).every((i) => overlap(a.bounds,b.bounds,i) > tolerance));
      if (!touching) fail('unsatisfied', 'no adjoining face connects the objects');
    }
  }
  for (const passage of passages) for (const body of bodies) {
    if (body.stableId === passage.owner) continue;
    if (body.passageClosure === 'bound-door' && [0,1,2].every((axis) => body.bounds.min[axis] >= passage.min[axis]-tolerance && body.bounds.max[axis] <= passage.max[axis]+tolerance)) continue;
    if ((body.occupiedBounds ?? [body.bounds]).some((bounds) => [0,1,2].every((axis) => Math.min(bounds.max[axis], passage.max[axis])-Math.max(bounds.min[axis],passage.min[axis]) > tolerance)))
      issues.push({kind:'unsatisfied',subjectId:body.stableId,detail:`blocks opening of ${passage.owner}`});
  }
  return issues;
}
