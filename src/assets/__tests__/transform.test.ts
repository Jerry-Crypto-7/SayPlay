import {describe,it,expect} from 'vitest';
import {Matrix3,Matrix4,Vector3} from 'three';
import {transformPoint,inversePoint,transformNormal,inverseNormal,transformBounds,fitRotatedBounds,type OrientedTransform} from '../transform';
const transform:OrientedTransform={scale:[2,3,0.5],translation:[7,2,-4],rotationY:Math.PI/3};
describe('oriented normalized asset frame',()=>{
  it('matches the renderer matrix for point and normal and reverses both',()=>{
    const matrix=new Matrix4().makeRotationY(transform.rotationY!).scale(new Vector3(...transform.scale)).setPosition(...transform.translation);
    const point=[1,0.7,-2] as const;
    const world=transformPoint(transform,point),expected=new Vector3(...point).applyMatrix4(matrix).toArray();
    world.forEach((v,i)=>expect(v).toBeCloseTo(expected[i],12));
    inversePoint(transform,world).forEach((v,i)=>expect(v).toBeCloseTo(point[i],12));
    const normal=[Math.SQRT1_2,0,Math.SQRT1_2] as const;
    const worldNormal=transformNormal(transform,normal),expectedNormal=new Vector3(...normal).applyNormalMatrix(new Matrix3().getNormalMatrix(matrix)).toArray();
    worldNormal.forEach((v,i)=>expect(v).toBeCloseTo(expectedNormal[i],12));
    inverseNormal(transform,worldNormal).forEach((v,i)=>expect(v).toBeCloseTo(normal[i],12));
  });
  it('rotates non-centered bounds through all corners without inverted bounds',()=>{
    const bounds=transformBounds({scale:[1,1,1],translation:[0,0,0],rotationY:Math.PI/2},{min:[0,0,0],max:[4,2,1]});
    expect(bounds.min[0]).toBeCloseTo(0);expect(bounds.max[0]).toBeCloseTo(1);
    expect(bounds.min[2]).toBeCloseTo(-4);expect(bounds.max[2]).toBeCloseTo(0);
  });
  it('fits a wide asset after a quarter turn without crushing its native proportions',()=>{
    const bounds={min:[0,0,0] as const,max:[4,2,1] as const},target={min:[-1,0,-4] as const,max:[1,4,4] as const};
    const fit=fitRotatedBounds(bounds,target,Math.PI/2),world=transformBounds(fit,bounds);
    fit.scale.forEach(value=>expect(value).toBeCloseTo(2));
    world.min.forEach((value,i)=>expect(value).toBeCloseTo(target.min[i]));
    world.max.forEach((value,i)=>expect(value).toBeCloseTo(target.max[i]));
  });
});
