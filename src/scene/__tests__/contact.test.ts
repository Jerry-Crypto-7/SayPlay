import {describe,it,expect} from 'vitest';
import {heightfieldSampler} from '../contact';
import {validateLayout,type LayoutBody} from '../constraints';
import {measureLayout} from '../layout';
import type {SceneSpec} from '../spec';
import {asset} from '@/assets/__fixtures__/catalog';
import {createAssetManifest} from '@/assets/manifest';
import {GEOM_VERSION,type GeomProgram} from '@/geom/program';
import type {SemanticObject} from '@/worldstream/schema';
const relation={relations:[{subjectId:'subject',targetId:'target',relation:'on'}]} as SceneSpec;
const positions=new Float32Array([0,0,0,0,0,2,2,2,2,0,0,0,2,2,2,2,2,0]);

describe('support contacts use declared seat anchors and actual terrain triangles',()=>{
  it('samples an inclined triangle field instead of its maximum height',()=>{
    const sample=heightfieldSampler(positions);
    expect(sample(0.25,1)?.height).toBeCloseTo(0.25);
    expect(sample(1.5,0.25)?.height).toBeCloseTo(1.5);
    expect(sample(3,1)).toBeNull();
    expect(sample(1,1)?.normal[1]).toBeCloseTo(Math.SQRT1_2);
  });
  it('accepts a seated person by the seat anchor while the feet stay below the seat',()=>{
    const target:LayoutBody={stableId:'target',bounds:{min:[-1,0,-1],max:[1,1.5,1]},supports:[{min:[-0.5,0.6,-0.5],max:[0.5,0.6,0.5]}]};
    const subject:LayoutBody={stableId:'subject',bounds:{min:[-0.3,0,-0.3],max:[0.3,1.5,0.3]},contact:{at:[0,0.6,0],normal:[0,-1,0]}};
    expect(validateLayout(relation,[subject,target])).toEqual([]);
    expect(validateLayout(relation,[{...subject,contact:undefined},target])[0].kind).toBe('unsatisfied');
    expect(validateLayout(relation,[{...subject,contact:{at:[0,1.5,0],normal:[0,-1,0]}},target])[0].kind).toBe('unsatisfied');
  });
  it('detects hovering, out-of-terrain placement and a rigid footprint intersecting the slope',()=>{
    const target:LayoutBody={stableId:'target',bounds:{min:[0,0,0],max:[2,2,2]},sampleGround:heightfieldSampler(positions)};
    const subject:LayoutBody={stableId:'subject',bounds:{min:[0.975,1,0.975],max:[1.025,2,1.025]}};
    expect(validateLayout(relation,[subject,target])).toEqual([]);
    expect(validateLayout(relation,[{...subject,bounds:{min:[0.975,2,0.975],max:[1.025,3,1.025]}},target])[0].detail).toContain('differs from terrain');
    expect(validateLayout(relation,[{...subject,bounds:{min:[0.5,1,0.5],max:[1.5,2,1.5]}},target])[0].detail).toContain('intersects uneven terrain');
    expect(validateLayout(relation,[{...subject,bounds:{min:[3,1,3],max:[4,2,4]}},target])[0].detail).toContain('outside');
  });
  it('oriented seat footprint refuses a contact in the empty corner of its enclosing AABB',()=>{
    const model=asset();model.bounds={min:[-1,0,-1],max:[1,1,1]};model.supportSurfaces=[{id:'seat',center:[0,1,0],width:2,depth:0.4}];
    const manifest=createAssetManifest({version:'worldstream-assets-v1',assets:[model]});
    const target:SemanticObject={stableId:'target',label:'seat',synonyms:[],role:'prop',importance:2,yaw:Math.PI/4,source:{kind:'asset',assetId:model.assetId,version:1,hash:model.hash},targetBounds:{min:[-Math.SQRT2,0,-Math.SQRT2],max:[Math.SQRT2,1,Math.SQRT2]}};
    const geometry:GeomProgram={version:GEOM_VERSION,nodes:[],root:0};
    const measured=measureLayout([target],geometry,manifest)[0];
    const subject:LayoutBody={stableId:'subject',bounds:{min:[0,0,0],max:[1,2,1]},contact:{at:[0,1,0],normal:[0,-1,0]}};
    expect(validateLayout(relation,[subject,measured])).toEqual([]);
    expect(validateLayout(relation,[{...subject,contact:{at:[0.7,1,0.7],normal:[0,-1,0]}},measured])[0].kind).toBe('unsatisfied');
  });
  it('shelf support uses the specified ledge, not the top of the whole bookshelf',()=>{
    const target:LayoutBody={stableId:'target',bounds:{min:[-1,0,-0.4],max:[1,2,0.4]},supports:[{min:[-1,0.8,-0.4],max:[1,0.8,0.4]},{min:[-1,1.6,-0.4],max:[1,1.6,0.4]}]};
    const book:LayoutBody={stableId:'subject',bounds:{min:[-0.2,0.8,-0.2],max:[0.2,1.1,0.2]}};
    expect(validateLayout(relation,[book,target])).toEqual([]);
    expect(validateLayout(relation,[{...book,bounds:{min:[-0.2,1,-0.2],max:[0.2,1.3,0.2]}},target])[0].kind).toBe('unsatisfied');
  });
  it('stairs sample different tread heights and consume an explicit finite CPU budget',()=>{
    const tread=(z:number,y:number)=>[0,y,z,0,y,z+1,2,y,z+1,0,y,z,2,y,z+1,2,y,z];
    const stairs=new Float32Array([...tread(0,0.2),...tread(1,0.4),...tread(2,0.6)]),sample=heightfieldSampler(stairs);
    expect(sample(1,0.5)?.height).toBeCloseTo(0.2);
    expect(sample(1,2.5)?.height).toBeCloseTo(0.6);
    expect(()=>heightfieldSampler(stairs,undefined,{remaining:1})(1,2.5)).toThrow('evaluation budget exceeded');
  });
});
