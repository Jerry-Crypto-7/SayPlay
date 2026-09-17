import type {Vec3} from '@/shape/types';

export interface SurfaceSample {readonly height:number;readonly normal:Vec3}
export interface ContactBudget {remaining:number}
/** Finite CPU budget shared by all terrain queries in one layout validation. */
export const CONTACT_TRIANGLE_BUDGET=2_000_000;
/** Vertical contact against actual authored triangles, not a terrain AABB. */
export function heightfieldSampler(positions:readonly number[]|Float32Array,indices?:readonly number[]|Uint16Array|Uint32Array,budget:ContactBudget={remaining:CONTACT_TRIANGLE_BUDGET}) {
  const count=indices?.length??positions.length/3;
  return (x:number,z:number):SurfaceSample|null=>{
    let best:SurfaceSample|null=null;
    const vertex=(index:number):Vec3=>{const i=(indices?indices[index]:index)*3;return [positions[i],positions[i+1],positions[i+2]];};
    for(let index=0;index+2<count;index+=3) {
      if(--budget.remaining<0)throw new Error('Contact triangle evaluation budget exceeded; simplify the support collision proxy');
      const a=vertex(index),b=vertex(index+1),c=vertex(index+2);
      const denominator=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);
      if(Math.abs(denominator)<1e-10)continue;
      const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/denominator;
      const v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/denominator,w=1-u-v;
      if(Math.min(u,v,w)<-1e-7)continue;
      const height=u*a[1]+v*b[1]+w*c[1];
      const ab=b.map((value,i)=>value-a[i]),ac=c.map((value,i)=>value-a[i]);
      const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
      const length=Math.hypot(...cross);
      if(length<1e-10||cross[1]/length<0.05)continue;
      if(!best||height>best.height)best={height,normal:cross.map(value=>value/length) as unknown as Vec3};
    }
    return best;
  };
}
