import { describe, expect, it } from 'vitest';
import { lowerArchitecture, type Architecture } from '../architecture';
import { compileGeomProgram } from '@/geom/compile';
import { GEOM_VERSION } from '@/geom/program';
import { validateLayout, type LayoutBody } from '../constraints';
import { measureLayout } from '../layout';
import type { SceneSpec } from '../spec';
import { asset } from '@/assets/__fixtures__/catalog';
import { createAssetManifest } from '@/assets/manifest';

const room = (stableId = 'room'): Architecture[number] => ({stableId,kind:'room',at:[0,0,0],width:8,depth:4,height:3,thickness:0.2,openings:[{wall:'south',offset:3,width:2,height:2.2}]});
const body = (stableId: string, min: [number,number,number],max:[number,number,number]): LayoutBody => ({stableId,bounds:{min,max}});
const spec = (relation: SceneSpec['relations'][number]['relation']): SceneSpec => ({version:1,requirements:[],instances:[],clarifications:[],relations:[{subjectId:'subject',targetId:'target',relation,provenance:{kind:'inferred',reason:'fixture'}}]});

describe('eight independent relational layout scenes', () => {
  it('1: non-square room has measured width/depth and continuous floor', () => {
    const lower = lowerArchitecture([room()]);
    const floor = compileGeomProgram({version:GEOM_VERSION,nodes:[lower.nodes[0]],root:0});
    expect(floor.boundingBox!.min.x).toBeCloseTo(-4);
    expect(floor.boundingBox!.max.z).toBeCloseTo(2);
    expect(floor.boundingBox!.max.y).toBeCloseTo(0);
    floor.dispose();
    const all = compileGeomProgram({version:GEOM_VERSION,nodes:lower.nodes,root:lower.roots.get('room')});
    expect(all.boundingBox!.max.x).toBeCloseTo(4.1);
    expect(all.boundingBox!.max.z).toBeCloseTo(2.1);
    all.dispose();
  });
  it('2: a table in a door approach is rejected; clear opening passes', () => {
    const {passages} = lowerArchitecture([room()]);
    expect(validateLayout(undefined,[body('table',[-0.5,0,1.6],[0.5,1,2.4])],passages)[0].detail).toContain('blocks opening');
    expect(validateLayout(undefined,[body('table',[2,0,0],[3,1,1])],passages)).toEqual([]);
  });
  it('3: corridor joins an adjoining balcony instead of floating nearby', () => {
    const target = body('target',[-4,0,-2],[4,3,2]);
    expect(validateLayout(spec('connected-to'),[target,body('subject',[4,0,-1],[6,0.3,1])])).toEqual([]);
    expect(validateLayout(spec('connected-to'),[target,body('subject',[4.5,0,-1],[6,0.3,1])])[0].kind).toBe('unsatisfied');
  });
  it('4: a supported object rests on the actual seat surface, not furniture top bounds', () => {
    const target = {...body('target',[-1,0,-1],[1,1.5,1]),supports:[{min:[-0.5,0.6,-0.5] as const,max:[0.5,0.6,0.5] as const}]};
    expect(validateLayout(spec('on'),[target,body('subject',[-0.3,0.6,-0.3],[0.3,1.8,0.3])])).toEqual([]);
    expect(validateLayout(spec('on'),[target,body('subject',[-0.3,1.5,-0.3],[0.3,2.7,0.3])])[0].kind).toBe('unsatisfied');
  });
  it('5: uneven terrain without contact samples is explicitly unsupported', () => {
    expect(validateLayout(spec('on'),[body('target',[-5,-1,-5],[5,2,5]),body('subject',[-0.2,2,-0.2],[0.2,3,0.2])])[0].kind).toBe('unsupported');
  });
  it('6: normalized asset forward direction determines facing, not prose', () => {
    const subject = {...body('subject',[-0.2,0,-0.2],[0.2,1.8,0.2]),forward:[0,0,1] as const};
    expect(validateLayout(spec('facing'),[subject,body('target',[-1,0,2],[1,1,3])])).toEqual([]);
    expect(validateLayout(spec('facing'),[subject,body('target',[-1,0,-3],[1,1,-2])])[0].kind).toBe('unsatisfied');
  });
  it('7: aquarium contents must stay inside and nearby props have bounded distance', () => {
    const bodies=[body('target',[-1,0,-1],[1,2,1]),body('subject',[-0.2,0.2,-0.2],[0.2,0.8,0.2])];
    expect(validateLayout(spec('inside'),bodies)).toEqual([]);
    expect(validateLayout(spec('inside'),[bodies[0],body('subject',[0,0,0],[2,1,1])])[0].kind).toBe('unsatisfied');
    expect(validateLayout(spec('near'),[bodies[0],body('subject',[8,0,0],[9,1,1])])[0].kind).toBe('unsatisfied');
  });
  it('8: native asset dimensions and support heights survive contain fit', () => {
    const entry=asset(); entry.supportSurfaces=[{id:'top',center:[0,1,0],width:1,depth:1}];
    const manifest=createAssetManifest({version:'worldstream-assets-v1',assets:[entry]});
    const measured=measureLayout([{stableId:'person',label:'person',synonyms:[],role:'hero',importance:3,source:{kind:'asset',assetId:entry.assetId,version:entry.version,hash:entry.hash},targetBounds:{min:[-5,0,-5],max:[5,2,5]}}],{version:GEOM_VERSION,nodes:[],root:0},manifest);
    expect(measured[0].bounds).toEqual({min:[-0.5,0,-0.5],max:[0.5,2,0.5]});
    expect(measured[0].supports![0].max[1]).toBe(1);
  });
  it('rejects overlapping openings and duplicate rooms', () => {
    const r=room(); r.openings.push({...r.openings[0],offset:3.5});
    expect(() => lowerArchitecture([r])).toThrow('overlapping');
    expect(() => lowerArchitecture([room(),room()])).toThrow('Duplicate');
  });
  it('permits only a bound door contained in the passage, not an arbitrary obstructing object', () => {
    const {passages} = lowerArchitecture([room()]);
    const door={...body('door',[-0.9,0,1.9],[0.9,2.1,2.1]),passageClosure:'bound-door' as const};
    expect(validateLayout(undefined,[door],passages)).toEqual([]);
    expect(validateLayout(undefined,[{...door,passageClosure:undefined}],passages)).toHaveLength(1);
    expect(validateLayout(undefined,[{...door,bounds:{min:[-2,0,1.9],max:[2,2.1,2.1]}}],passages)).toHaveLength(1);
  });
  it('connected rooms use occupied slabs rather than treating the room interior as solid', () => {
    const {passages} = lowerArchitecture([room()]);
    const adjoining = {...body('corridor',[-1,0,1.8],[1,3,6]),occupiedBounds:[{min:[-1,-0.2,1.8] as const,max:[1,0,6] as const}]};
    expect(validateLayout(undefined,[adjoining],passages)).toEqual([]);
    expect(validateLayout(undefined,[{...adjoining,occupiedBounds:undefined}],passages)).toHaveLength(1);
  });
  it('a row of five independently placed listeners each faces the same target',()=>{
    const target=body('target',[-3,0,4],[3,2,5]);
    const listeners=Array.from({length:5},(_,i)=>({...body(`person${i}`,[i-2.2,0,-0.2],[i-1.8,1.8,0.2]),forward:[0,0,1] as const}));
    const row={...spec('facing'),relations:listeners.map(p=>({...spec('facing').relations[0],subjectId:p.stableId}))};
    expect(validateLayout(row,[target,...listeners])).toEqual([]);
    expect(validateLayout(row,[target,...listeners.slice(1)])[0].kind).toBe('unsupported');
  });
});
