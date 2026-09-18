import {describe,it,expect} from 'vitest';
import {buildIntentPreview} from '../intent-preview';
import {MASSING_PREVIEW_NOTICE,buildMassingPreview,isMassingPreview} from '../massing-preview';
import {measureLayout} from '../layout';
import {WORLDSTREAM_ASSETS} from '@/assets/catalog';
import {visualPreviewSchema} from '@/worldstream/schema';
import type {PlannerEmission,PlannedObject} from '@/model/worldstream-intent';
import type {SceneSpec} from '../spec';
import {buildVisualPreviewFrom} from '@/worldstream/proxy';

const provenance={kind:'inferred' as const,reason:'Massing preview regression fixture'};

/**
 * Plán se **sceneSpec**, který se dá poskládat z libovolného seznamu objektů.
 *
 * Archiv `create-raw.json` ani ten z T18 tady číst nejde: obojí je
 * v `.gitignore`, takže v čistém klonu neexistuje a `npm test` by na něm padal.
 * Fixtury proto vznikají v testu — měření nad opravdovými emisemi má vlastní
 * soubor `evals/worldstream/massing-preview.measure.ts`.
 */
function planOf(objects:PlannedObject[],relations:SceneSpec['relations']=[]):PlannerEmission {
  return {intent:{setting:'A reading room, aquarium and two seated people facing it',mood:'calm',spatialThesis:'Seats face the aquarium',
      actors:['two people'],heroObjects:['aquarium'],interactions:[],unsupported:[]},objects,
    sceneSpec:{version:1,clarifications:[],
      requirements:objects.map(o=>({id:o.stableId,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
      instances:objects.map(o=>({stableId:o.stableId,requirementIds:[o.stableId],role:o.role,provenance,attributes:[],
        orientation:{description:'Facing specified by relations',provenance}})),
      relations}};
}

/** Táž šestice identit, kterou přísný náhled přijímá (`intent-preview.test.ts`). */
function plan():PlannerEmission {
  const objects=[{stableId:'room',label:'Reading room',role:'architecture' as const},
    {stableId:'aquarium',label:'Glass aquarium',role:'hero' as const},
    {stableId:'chairA',label:'Lounge chair',role:'prop' as const},{stableId:'chairB',label:'Lounge chair',role:'prop' as const},
    {stableId:'personA',label:'Seated person',role:'prop' as const},{stableId:'personB',label:'Seated person',role:'prop' as const}]
    .map(o=>({...o,synonyms:[],importance:2 as const}));
  return planOf(objects,[...objects.filter(o=>o.stableId!=='room').map(o=>({subjectId:o.stableId,targetId:'room',relation:'inside' as const,provenance})),
    ...['A','B'].flatMap(s=>[{subjectId:`person${s}`,targetId:`chair${s}`,relation:'on' as const,provenance},
      {subjectId:`person${s}`,targetId:'aquarium',relation:'facing' as const,provenance}])]);
}

function withRelation(p:PlannerEmission,subjectId:string,relation:SceneSpec['relations'][number]['relation'],targetId:string):PlannerEmission {
  p.sceneSpec!.relations.push({subjectId,relation,targetId,provenance});return p;
}

/** Všech pět rolí a čtyři stupně `importance` naráz — měřítko má odkud vzniknout. */
function everyRolePlan():PlannerEmission {
  const objects:PlannedObject[]=[
    {stableId:'courtyard',label:'the courtyard ground',role:'terrain',importance:1,synonyms:['ground']},
    {stableId:'readingRoom',label:'the reading room',role:'architecture',importance:3,synonyms:['room']},
    {stableId:'bigAquarium',label:'the glass aquarium',role:'hero',importance:3,synonyms:['aquarium']},
    {stableId:'smallRelic',label:'the small relic',role:'hero',importance:0,synonyms:['relic']},
    {stableId:'loungeChair',label:'the lounge chair',role:'prop',importance:2,synonyms:['chair']},
    {stableId:'dustMotes',label:'the drifting dust',role:'effect',importance:0,synonyms:['dust']},
  ];
  return planOf(objects);
}

const massNodes=(p:PlannerEmission,seed=17)=>{const r=buildMassingPreview(p,{sessionSeed:seed});
  if(!r.ok)throw new Error(`${r.reason}: ${r.details.join('; ')}`);return r;};

describe('the rough massing preview, which the plan never refuses',()=>{
  it('gives every planned identity exactly one block and no extra geometry',()=>{
    const p=everyRolePlan(),before=JSON.stringify(p),result=massNodes(p);
    expect(result.preview.objects.map(o=>o.stableId)).toEqual(p.objects.map(o=>o.stableId));
    expect(result.origins.map(o=>o.stableId)).toEqual(p.objects.map(o=>o.stableId));
    // Počet hmot = počet objektů v rejstříku plánovače. Skupiny jsou nosníky,
    // ne tělesa, takže se počítají zvlášť.
    expect(result.preview.geometry.nodes.filter(n=>n.kind==='mass')).toHaveLength(p.objects.length);
    expect(result.preview.geometry.nodes.every(n=>n.kind==='mass'||n.kind==='group')).toBe(true);
    expect(new Set(result.preview.objects.map(o=>o.source.kind==='geom'?o.source.node:-1)).size).toBe(p.objects.length);
    expect(visualPreviewSchema.safeParse(result.preview).success).toBe(true);
    // Plán se nesmí změnit a druhé volání musí dát doslova totéž.
    expect(JSON.stringify(p)).toBe(before);
    expect(buildMassingPreview(p,{sessionSeed:17})).toEqual(result);
  });

  it('takes every size from role and importance, and every cell from the emission order',()=>{
    const result=massNodes(everyRolePlan()),by=(id:string)=>result.origins.find(o=>o.stableId===id)!;
    expect(result.origins.map(o=>o.index)).toEqual([0,1,2,3,4,5]);
    for(const origin of result.origins)expect(origin.size).toEqual(
      (result.preview.geometry.nodes[origin.node] as {scale:[number,number,number]}).scale);

    // Role rozhoduje o tvaru: hrdina je větší než rekvizita, rekvizita než efekt.
    expect(by('bigAquarium').size[0]).toBeGreaterThan(by('loungeChair').size[0]);
    expect(by('loungeChair').size[0]).toBeGreaterThan(by('dustMotes').size[0]);
    // Importance rozhoduje o měřítku uvnitř téže role.
    expect(by('bigAquarium').size[0]).toBeGreaterThan(by('smallRelic').size[0]);
    expect(by('bigAquarium').importance).toBe(3);expect(by('smallRelic').importance).toBe(0);

    // Terén a architektura jsou desky pod nulou, v pořadí z emise; ostatní na ní stojí.
    expect(by('courtyard').basis).toBe('ground-plate');expect(by('readingRoom').basis).toBe('ground-plate');
    expect(by('loungeChair').basis).toBe('grid-cell');
    const plate=(id:string)=>result.preview.objects.find(o=>o.stableId===id)!.targetBounds;
    expect(plate('courtyard').max[1]).toBeCloseTo(0,6);
    expect(plate('readingRoom').max[1]).toBeCloseTo(plate('courtyard').min[1],6);
    for(const id of ['bigAquarium','smallRelic','loungeChair','dustMotes'])
      expect(result.preview.objects.find(o=>o.stableId===id)!.targetBounds.min[1]).toBeCloseTo(0,6);
    // Deska je širší než mřížka, kterou nese.
    expect(plate('courtyard').max[0]).toBeGreaterThan(Math.max(...result.origins.filter(o=>o.basis==='grid-cell').map(o=>o.at[0]+o.size[0]/2)));
    // Žádné dvě hmoty v mřížce nesdílejí buňku.
    const cells=result.origins.filter(o=>o.basis==='grid-cell').map(o=>`${String(o.at[0])}/${String(o.at[2])}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('puts each block where its own targetBounds claims, measured through the real layout',()=>{
    const result=massNodes(everyRolePlan());
    for(const body of measureLayout(result.preview.objects,result.preview.geometry,WORLDSTREAM_ASSETS)){
      const declared=result.preview.objects.find(o=>o.stableId===body.stableId)!.targetBounds;
      for(const axis of [0,1,2]){
        expect(body.bounds.min[axis]).toBeCloseTo(declared.min[axis],5);
        expect(body.bounds.max[axis]).toBeCloseTo(declared.max[axis],5);
      }
    }
  });

  it('marks itself as rough in the payload that survives a reconnect',()=>{
    const rough=massNodes(everyRolePlan()).preview;
    expect(rough.validation.limitations[0]).toBe(MASSING_PREVIEW_NOTICE);
    expect(rough.validation.layout).toBe('not-requested');
    expect(isMassingPreview(rough)).toBe(true);
    const strict=buildIntentPreview(plan(),{sessionSeed:17});
    expect(strict.ok).toBe(true);if(!strict.ok)return;
    expect(isMassingPreview(strict.preview)).toBe(false);
    expect(strict.preview.validation.layout).toBe('checked');
  });

  it('still builds a preview for every plan the strict path refuses',async()=>{
    const refused:[string,PlannerEmission][]=[
      ['UNSUPPORTED_RELATION',withRelation(plan(),'chairA','against','room')],
      ['CONTRADICTORY_SUPPORT',withRelation(plan(),'personA','on','chairB')],
      ['CYCLIC_SUPPORT',withRelation(plan(),'chairA','on','personA')],
      ['UNSUPPORTED_CONNECTION',withRelation(plan(),'chairA','connected-to','room')],
      ['UNSUPPORTED_ENCLOSURE',planOf([
        {stableId:'roomOne',label:'the first hall',role:'architecture',importance:2,synonyms:[]},
        {stableId:'roomTwo',label:'the second hall',role:'architecture',importance:2,synonyms:[]},
        {stableId:'relic',label:'the relic',role:'hero',importance:2,synonyms:[]}])],
    ];
    for(const [reason,p] of refused){
      expect(buildIntentPreview(p,{sessionSeed:17}),reason).toMatchObject({ok:false,reason});
      const rough=massNodes(p);
      expect(rough.preview.objects).toHaveLength(p.objects.length);
      expect(visualPreviewSchema.safeParse(rough.preview).success).toBe(true);
    }
    // A ten náhled se doopravdy dá nakreslit, bez jediného meshovaného tvaru.
    const built=await buildVisualPreviewFrom(massNodes(refused[0][1]).preview,
      {mesh:async()=>{throw new Error('A massing preview must not require shape meshing');}});
    expect(built.kind).toBe('built');if(built.kind!=='built')return;
    expect(built.slots).toHaveLength(refused[0][1].objects.length);
    expect(built.slots.every(s=>s.form.kind!=='asset')).toBe(true);
  });

  it('leaves buildIntentPreview exactly as strict as it was',()=>{
    expect(buildIntentPreview(plan(),{sessionSeed:17})).toMatchObject({ok:true,provisional:true});
    expect(buildIntentPreview(plan(),{sessionSeed:17})).toEqual(buildIntentPreview(plan(),{sessionSeed:17}));
    expect(buildIntentPreview({...plan(),sceneSpec:undefined},{sessionSeed:1})).toMatchObject({ok:false,reason:'INVALID_SCENE_SPEC'});
    expect(buildIntentPreview(withRelation(plan(),'chairA','against','room'),{sessionSeed:1})).toMatchObject({ok:false,reason:'UNSUPPORTED_RELATION'});
    expect(buildIntentPreview(withRelation(plan(),'personA','facing','chairB'),{sessionSeed:1})).toMatchObject({ok:false,reason:'CONTRADICTORY_FACING'});
    // A přísný náhled zůstává tím jediným, kdo relace ověřuje: hrubý je nikdy netvrdí.
    const rough=massNodes(plan()).preview;
    expect(rough.validation.layout).toBe('not-requested');
    expect(rough.objects.every(o=>o.source.kind==='geom'&&o.yaw===undefined&&o.binding===undefined)).toBe(true);
  });

  it('keeps the whole massing inside one geom program, however many identities arrive',()=>{
    const many=planOf(Array.from({length:120},(_,i)=>({stableId:`obj${String(i)}`,label:`object ${String(i)}`,
      role:'prop' as const,importance:1 as const,synonyms:[]})));
    const result=massNodes(many);
    expect(result.preview.geometry.nodes.length).toBeLessThanOrEqual(96);
    expect(visualPreviewSchema.safeParse(result.preview).success).toBe(true);
    // Co se nevešlo, je napsané v omezeních, ne zamlčené.
    expect(result.preview.objects.length).toBe(result.origins.length);
    expect(result.preview.objects.length).toBeLessThan(many.objects.length);
    expect(result.preview.validation.limitations.join(' ')).toContain('120 planned identities');
    // Zkrácený rejstřík už neodpovídá sceneSpec, takže se spec nepřipojuje.
    expect(result.preview.sceneSpec).toBeUndefined();
  });
});
