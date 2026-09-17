import {describe,it,expect} from 'vitest';
import {assessShapeDetail} from '../detail-policy';
import type {ShapeProgram,ShapeNode} from '../types';
import {shapeContentHash} from '@/worldstream/cache';

const program=(nodes:ShapeNode[],span=10):ShapeProgram=>({shapeId:'detail',stableId:'detail-object',nodes,root:nodes.length-1,targetBounds:{min:[-span/2,-span/2,-span/2],max:[span/2,span/2,span/2]},anchors:[],materialIntent:'bone',priority:2});
describe('feature-relative SDF sampling diagnostics',()=>{
  it('compares explicit thin features with padded voxel size and keeps cache identity unchanged',()=>{
    const shape=program([{kind:'box',size:[0.02,2,2]}]);const before=structuredClone(shape),hash=shapeContentHash(shape,32);
    const report=assessShapeDetail(shape,32);
    expect(report.status).toBe('sampling-risk');expect(report.features[0].cells).toBeCloseTo(0.02/(10*1.0625/32));
    expect(report.recommendation).toContain('Node 0');expect(report.recommendation).toContain('Split');
    expect(shape).toEqual(before);expect(shapeContentHash(shape,32)).toEqual(hash);
  });
  it('finds scale-through-DAG and repeated detail without expanding array instances or unreachable nodes',()=>{
    const shape=program([{kind:'sphere',radius:1},{kind:'scale',child:0,factor:[0.01,1,1]},
      {kind:'repeat',child:1,count:20,step:[0.4,0,0]}, {kind:'sphere',radius:0.0001}, {kind:'translate',child:2,offset:[0,0,0]}]);
    const report=assessShapeDetail(shape,48);
    expect(report.features).toHaveLength(1);expect(report.features[0].meters).toBeCloseTo(0.02);
    expect(report.recommendation).toContain('instance');
  });
  it('recognizes tighter-bounds improvement without prescribing a global resolution increase',()=>{
    const shape=program([{kind:'torus',majorRadius:0.5,minorRadius:0.12}],2);
    expect(assessShapeDetail(shape,16).status).toBe('sampling-risk');
    expect(assessShapeDetail(shape,32).status).toBe('no-explicit-risk');
    expect(assessShapeDetail(shape,48).resolution).toBe(48);
  });
  it('does not certify CSG walls or deformation from thick inputs',()=>{
    const shape=program([{kind:'sphere',radius:2},{kind:'sphere',radius:1.99},{kind:'subtract',children:[0,1]}],5);
    expect(assessShapeDetail(shape,48)).toMatchObject({status:'unassessed',recommendation:expect.stringContaining('CSG')});
    expect(assessShapeDetail(program([{kind:'sphere',radius:1},{kind:'bend',child:0,axis:'x',curvature:1}],3),48).status).toBe('unassessed');
  });
});
