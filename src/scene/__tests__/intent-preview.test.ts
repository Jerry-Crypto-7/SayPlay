import {describe,it,expect} from 'vitest';
import {buildIntentPreview} from '../intent-preview';
import {measureLayout} from '../layout';
import {validateLayout} from '../constraints';
import {WORLDSTREAM_ASSETS} from '@/assets/catalog';
import {visualPreviewSchema} from '@/worldstream/schema';
import type {PlannerEmission,PlannedObject} from '@/model/worldstream-intent';
import type {SceneSpec} from '../spec';
import {buildVisualPreviewFrom} from '@/worldstream/proxy';
const provenance={kind:'inferred' as const,reason:'Independent deterministic layout regression fixture'};
function plan():Omit<PlannerEmission,'objects'>&{objects:PlannedObject[]} {
  const objects=[{stableId:'room',label:'Reading room',role:'architecture' as const},
    {stableId:'aquarium',label:'Glass aquarium',role:'hero' as const},
    {stableId:'chairA',label:'Lounge chair',role:'prop' as const},{stableId:'chairB',label:'Lounge chair',role:'prop' as const},
    {stableId:'personA',label:'Seated person',role:'prop' as const},{stableId:'personB',label:'Seated person',role:'prop' as const}].map(o=>({...o,synonyms:[],importance:2 as const}));
  return {intent:{setting:'A reading room, aquarium and two seated people facing it',mood:'calm',spatialThesis:'Seats face the aquarium',actors:['two people'],heroObjects:['aquarium'],interactions:[],unsupported:[]},objects,
    sceneSpec:{version:1,requirements:objects.map(o=>({id:o.stableId,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
      instances:objects.map(o=>({stableId:o.stableId,requirementIds:[o.stableId],role:o.role,provenance,attributes:[],orientation:{description:'Facing specified by relations',provenance}})),
      relations:[...objects.filter(o=>o.stableId!=='room').map(o=>({subjectId:o.stableId,targetId:'room',relation:'inside' as const,provenance})),
        ...['A','B'].flatMap(s=>[{subjectId:`person${s}`,targetId:`chair${s}`,relation:'on' as const,provenance},{subjectId:`person${s}`,targetId:'aquarium',relation:'facing' as const,provenance}])],clarifications:[]}};
}
function withRelation(p:PlannerEmission,subjectId:string,relation:SceneSpec['relations'][number]['relation'],targetId:string){p.sceneSpec!.relations.push({subjectId,relation,targetId,provenance});return p;}
// Typed regression of the six identities/relations from the 17 September
// early-preview live observation; fixture only, never a fresh model emission.
function terminalPlan():PlannerEmission {
  const objects:PlannedObject[]=[
    {stableId:'readingRoom',label:'the small reading room',role:'architecture',importance:2,synonyms:['room','reading room','small room']},
    {stableId:'glassAquarium',label:'the glass aquarium',role:'hero',importance:2,synonyms:['aquarium','glass aquarium','tank','fish tank']},
    {stableId:'firstPerson',label:'the first seated person',role:'prop',importance:2,synonyms:['person','seated person','first person','first seated person','viewer']},
    {stableId:'secondPerson',label:'the second seated person',role:'prop',importance:2,synonyms:['person','seated person','second person','second seated person','viewer']},
    {stableId:'computerTerminal',label:'the computer terminal',role:'hero',importance:2,synonyms:['computer','terminal','computer terminal','control terminal']},
    {stableId:'signalLight',label:'the signal light',role:'prop',importance:2,synonyms:['light','signal light','indicator','indicator light','signal lamp']},
  ];
  return {...plan(),objects,sceneSpec:{version:1,clarifications:[],
    requirements:objects.map(o=>({id:o.stableId,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
    instances:objects.map(o=>({stableId:o.stableId,requirementIds:[o.stableId],role:o.role,attributes:[],provenance,orientation:{description:'Facing specified by relations',provenance}})),
    relations:[...objects.slice(1).map(o=>({subjectId:o.stableId,relation:'inside' as const,targetId:'readingRoom',provenance})),
      ...['firstPerson','secondPerson'].map(subjectId=>({subjectId,relation:'facing' as const,targetId:'glassAquarium',provenance})),
      {subjectId:'computerTerminal',relation:'connected-to',targetId:'signalLight',provenance}]}};
}
describe('provisional layouts from the exact current planner identities',()=>{
  it('places the live terminal-light relation as a measured adjacent pair, preserving people and every relation',()=>{
    const p=terminalPlan(),before=JSON.stringify(p),result=buildIntentPreview(p,{sessionSeed:17});
    expect(result,JSON.stringify(result)).toMatchObject({ok:true});if(!result.ok)return;
    expect(result.preview.sceneSpec).toEqual(p.sceneSpec);
    expect(result.preview.objects.map(o=>o.stableId).sort()).toEqual(p.objects.map(o=>o.stableId).sort());
    const bodies=measureLayout(result.preview.objects,result.preview.geometry,WORLDSTREAM_ASSETS);
    expect(validateLayout(p.sceneSpec,bodies)).toEqual([]);
    const terminal=bodies.find(b=>b.stableId==='computerTerminal')!,light=bodies.find(b=>b.stableId==='signalLight')!;
    // Measured GLB bounds pass through Float32 geometry attributes.
    expect(terminal.bounds.max[0]).toBeCloseTo(light.bounds.min[0],6);
    for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){
      const a=bodies[i],b=bodies[j];if(a.stableId==='readingRoom'||b.stableId==='readingRoom')continue;
      expect([0,1,2].every(axis=>Math.min(a.bounds.max[axis],b.bounds.max[axis])-Math.max(a.bounds.min[axis],b.bounds.min[axis])>0.08)).toBe(false);
    }
    expect(result.preview.objects.find(o=>o.stableId==='computerTerminal')!.source.kind).toBe('asset');
    // The catalog has no signal-light asset: retain its own labeled rough
    // geometry rather than substituting a lamp or claiming final appearance.
    expect(result.preview.objects.find(o=>o.stableId==='signalLight')!.source.kind).toBe('geom');
    expect(result.preview.validation.limitations.join(' ')).toContain('signalLight: explicit unit-block rough proxy');
    expect(result.preview.validation.limitations.join(' ')).toContain('no cable, port, electrical behavior');
    expect(JSON.stringify(p)).toBe(before);expect(buildIntentPreview(p,{sessionSeed:17})).toEqual(result);
  });
  it.each([
    ['signalLight','connected-to','glassAquarium'], // chain
    ['signalLight','connected-to','computerTerminal'], // reverse cycle
    ['computerTerminal','on','glassAquarium'], // endpoint support
    ['firstPerson','on','computerTerminal'], // endpoint supporting others
    ['computerTerminal','facing','glassAquarium'], // rotated endpoint
    ['signalLight','connected-to','readingRoom'], // nonphysical endpoint
  ] as const)('refuses unsupported connected pair combination %s %s %s', (subject,relation,target)=>{
    expect(buildIntentPreview(withRelation(terminalPlan(),subject,relation,target),{sessionSeed:17})).toMatchObject({ok:false,reason:'UNSUPPORTED_CONNECTION'});
  });
  it('lays out two separate seated catalog people on real support sockets, facing the aquarium inside measured room slabs',()=>{
    const p=plan(),before=JSON.stringify(p),result=buildIntentPreview(p,{sessionSeed:17});
    expect(result,JSON.stringify(result)).toMatchObject({ok:true,provisional:true});if(!result.ok)return;
    expect(visualPreviewSchema.safeParse(result.preview).success).toBe(true);
    expect(result.preview.stage).toBe('intent-layout');expect(result.preview.interactive).toBe(false);
    expect(result.preview.objects.map(o=>o.stableId).sort()).toEqual(p.objects.map(o=>o.stableId).sort());
    expect(result.preview.objects.filter(o=>o.supportSocket==='seat')).toHaveLength(2);
    expect(validateLayout(p.sceneSpec,measureLayout(result.preview.objects,result.preview.geometry,WORLDSTREAM_ASSETS))).toEqual([]);
    expect(JSON.stringify(p)).toBe(before);expect(buildIntentPreview(p,{sessionSeed:17})).toEqual(result);
    for(const field of ['world','sim','simHash','simRevision','lookRevision','certificate'])expect(result.preview).not.toHaveProperty(field);
    expect(result.preview.objects.every(o=>!o.binding?.entityId&&!o.binding?.signalFlag)).toBe(true);
  });
  it('keeps unknown identity as an explicit rough proxy rather than borrowing a known object',()=>{
    const p=plan();p.objects[1]={...p.objects[1],label:'Quzox undecipherable relic'};
    p.sceneSpec!.relations=p.sceneSpec!.relations.filter(r=>r.relation!=='facing');
    const result=buildIntentPreview(p,{sessionSeed:8});expect(result,JSON.stringify(result)).toMatchObject({ok:true});if(!result.ok)return;
    expect(result.preview.objects.find(o=>o.stableId==='aquarium')!.source.kind).toBe('geom');
    expect(result.preview.validation.limitations.join(' ')).toContain('aquarium: explicit unit-block rough proxy');
  });
  it('refuses against rather than returning checked layout',()=>{
    expect(buildIntentPreview(withRelation(plan(),'chairA','against','room'),{sessionSeed:1})).toMatchObject({ok:false,reason:'UNSUPPORTED_RELATION'});
  });
  it('rejects contradictory supports, cycles, duplicate facing targets and mismatched counts',()=>{
    expect(buildIntentPreview(withRelation(plan(),'personA','on','chairB'),{sessionSeed:1})).toMatchObject({ok:false,reason:'CONTRADICTORY_SUPPORT'});
    expect(buildIntentPreview(withRelation(plan(),'chairA','on','personA'),{sessionSeed:1})).toMatchObject({ok:false,reason:'CYCLIC_SUPPORT'});
    expect(buildIntentPreview(withRelation(plan(),'personA','facing','chairB'),{sessionSeed:1})).toMatchObject({ok:false,reason:'CONTRADICTORY_FACING'});
    const p=plan();p.sceneSpec!.requirements[0].count=2;expect(buildIntentPreview(p,{sessionSeed:1})).toMatchObject({ok:false,reason:'INVALID_SCENE_SPEC'});
  });
  it('refuses unsupported support surfaces and complex architecture',()=>{
    const p=plan();p.sceneSpec!.relations=p.sceneSpec!.relations.filter(r=>!(r.subjectId==='personA'&&(r.relation==='on'||r.relation==='facing')));withRelation(p,'personA','on','aquarium');
    expect(buildIntentPreview(p,{sessionSeed:1})).toMatchObject({ok:false,reason:'UNSUPPORTED_SUPPORT'});
    const complex=plan();complex.objects[0]={...complex.objects[0],label:'Spiral castle tower'};
    expect(buildIntentPreview(complex,{sessionSeed:1})).toMatchObject({ok:false,reason:'UNSUPPORTED_ARCHITECTURE'});
  });
  it('rejects two people occupying the same seat instead of merging or silently overlapping them',()=>{
    const p=plan();p.sceneSpec!.relations=p.sceneSpec!.relations.map(r=>r.subjectId==='personB'&&r.relation==='on'?{...r,targetId:'chairA'}:r);
    expect(buildIntentPreview(p,{sessionSeed:1})).toMatchObject({ok:false,reason:'OVERLAPPING_LAYOUT'});
  });
  it('supports a measured flat terrain and near relation without a fabricated enclosing room',()=>{
    const p=plan();p.objects[0]={...p.objects[0],label:'Flat courtyard ground',role:'terrain'};p.sceneSpec!.instances[0].role='terrain';
    p.sceneSpec!.relations=p.sceneSpec!.relations.filter(r=>r.relation!=='inside');
    for(const id of ['aquarium','chairA','chairB'])withRelation(p,id,'on','room');
    withRelation(p,'chairA','near','aquarium');
    const result=buildIntentPreview(p,{sessionSeed:3});expect(result,JSON.stringify(result)).toMatchObject({ok:true});if(!result.ok)return;
    expect(result.preview.geometry.nodes.some(n=>n.kind==='terrain'&&n.variant==='flat')).toBe(true);
    expect(validateLayout(p.sceneSpec,measureLayout(result.preview.objects,result.preview.geometry,WORLDSTREAM_ASSETS))).toEqual([]);
  });
  it('reaches the real visual-only proxy adapter without a synthetic simulation',async()=>{
    const result=buildIntentPreview(plan(),{sessionSeed:4});expect(result.ok).toBe(true);if(!result.ok)return;
    const built=await buildVisualPreviewFrom(result.preview,{mesh:async()=>{throw new Error('Intent preview must not require shape meshing');}});
    expect(built.kind).toBe('built');if(built.kind!=='built')return;
    expect(built.slots).toHaveLength(6);expect(built.slots.filter(s=>s.form.kind==='asset')).toHaveLength(5);
  });
  it('refuses missing SceneSpec and contradictory roles instead of upgrading an old plan silently',()=>{
    expect(buildIntentPreview({...plan(),sceneSpec:undefined},{sessionSeed:1})).toMatchObject({ok:false,reason:'INVALID_SCENE_SPEC'});
    const p=plan();p.sceneSpec!.instances[0].role='terrain';
    expect(buildIntentPreview(p,{sessionSeed:1})).toMatchObject({ok:false,reason:'CONTRADICTORY_ROLE'});
  });
});
