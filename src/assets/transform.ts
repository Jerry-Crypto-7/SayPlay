import type {Bounds3,Vec3} from '@/shape/types';

export interface OrientedTransform {readonly scale:Vec3;readonly translation:Vec3;readonly rotationY?:number}
export function rotateY(point:Vec3,angle:number):Vec3 {
  const c=Math.cos(angle),s=Math.sin(angle);
  return [point[0]*c+point[2]*s,point[1],-point[0]*s+point[2]*c];
}
export function transformPoint(transform:OrientedTransform,point:Vec3):Vec3 {
  const rotated=rotateY(point.map((value,i)=>value*transform.scale[i]) as unknown as Vec3,transform.rotationY??0);
  return rotated.map((value,i)=>value+transform.translation[i]) as unknown as Vec3;
}
export function inversePoint(transform:OrientedTransform,point:Vec3):Vec3 {
  const unrotated=rotateY(point.map((value,i)=>value-transform.translation[i]) as unknown as Vec3,-(transform.rotationY??0));
  return unrotated.map((value,i)=>value/transform.scale[i]) as unknown as Vec3;
}
function unit(vector:Vec3):Vec3 {const length=Math.hypot(...vector);if(length===0)throw new Error('Normal must be nonzero');return vector.map(value=>value/length) as unknown as Vec3;}
/** Inverse-transpose of rotation * scale, including approved anisotropic scale. */
export function transformNormal(transform:OrientedTransform,normal:Vec3):Vec3 {
  return unit(rotateY(normal.map((value,i)=>value/transform.scale[i]) as unknown as Vec3,transform.rotationY??0));
}
export function inverseNormal(transform:OrientedTransform,normal:Vec3):Vec3 {
  const unrotated=rotateY(normal,-(transform.rotationY??0));
  return unit(unrotated.map((value,i)=>value*transform.scale[i]) as unknown as Vec3);
}
/** Transform all eight corners; rotating min/max alone can invert or shrink a box. */
export function transformBounds(transform:OrientedTransform,bounds:Bounds3):Bounds3 {
  const corners=[bounds.min[0],bounds.max[0]].flatMap(x=>[bounds.min[1],bounds.max[1]].flatMap(y=>[bounds.min[2],bounds.max[2]].map(z=>transformPoint(transform,[x,y,z]))));
  return {min:[0,1,2].map(i=>Math.min(...corners.map(p=>p[i]))) as unknown as Vec3,max:[0,1,2].map(i=>Math.max(...corners.map(p=>p[i]))) as unknown as Vec3};
}

/** Uniform contain fit in the rotated world frame; bottom aligned, horizontal center aligned. */
export function fitRotatedBounds(bounds:Bounds3,target:Bounds3,rotationY:number):OrientedTransform {
  if(!Number.isFinite(rotationY))throw new Error('Asset yaw must be finite');
  const rotated=transformBounds({scale:[1,1,1],translation:[0,0,0],rotationY},bounds);
  const sourceSize=rotated.max.map((value,i)=>value-rotated.min[i]);
  const targetSize=target.max.map((value,i)=>value-target.min[i]);
  if([...sourceSize,...targetSize].some(value=>!Number.isFinite(value)||value<=0))throw new Error('Fit requires finite positive bounds');
  const scale=Math.min(...targetSize.map((value,i)=>value/sourceSize[i]));
  const translation=target.min.map((value,i)=>i===1?value-rotated.min[i]*scale:(value+target.max[i]-(rotated.min[i]+rotated.max[i])*scale)/2) as unknown as Vec3;
  return {scale:[scale,scale,scale],translation,...(rotationY===0?{}:{rotationY})};
}
