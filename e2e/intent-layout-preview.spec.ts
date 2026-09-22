import {test,expect} from '@playwright/test';
import {buildIntentPreview} from '../src/scene/intent-preview';
import {DEMO_BLUEPRINT} from '../src/app/dev/demo-world';
import type {PlannerEmission} from '../src/model/worldstream-intent';

test('own provisional layout is visible while compilation is pending, without a runtime or prepared replacement',async({page},info)=>{
  const provenance={kind:'inferred' as const,reason:'Explicit transport fixture for progressive UI'};
  const objects=[{stableId:'room',label:'Reading room',role:'architecture' as const},
    {stableId:'aquarium',label:'Glass aquarium',role:'hero' as const},
    {stableId:'personA',label:'Seated person',role:'prop' as const},
    {stableId:'personB',label:'Seated person',role:'prop' as const},
    {stableId:'terminal',label:'Computer terminal',role:'prop' as const},
    {stableId:'signal',label:'Signal light',role:'prop' as const}].map(o=>({...o,synonyms:[],importance:2 as const}));
  const plan:PlannerEmission={intent:{setting:'Reading room with an aquarium and two people',mood:'calm',spatialThesis:'Two people face the aquarium',actors:['two people'],heroObjects:['aquarium'],interactions:[],unsupported:[]},objects,
    sceneSpec:{version:1,clarifications:[],requirements:objects.map(o=>({id:o.stableId,description:o.label,priority:'main',polarity:'required',count:1,instanceIds:[o.stableId],provenance})),
      instances:objects.map(o=>({stableId:o.stableId,requirementIds:[o.stableId],role:o.role,provenance,attributes:[],orientation:{description:'upright',provenance}})),
      relations:[...objects.filter(o=>o.stableId!=='room').map(o=>({subjectId:o.stableId,targetId:'room',relation:'inside' as const,provenance})),
        ...['personA','personB'].map(subjectId=>({subjectId,targetId:'aquarium',relation:'facing' as const,provenance})),
        {subjectId:'terminal',targetId:'signal',relation:'connected-to',provenance}]}};
  const built=buildIntentPreview(plan,{sessionSeed:4021});if(!built.ok)throw new Error(JSON.stringify(built));
  const id='intent-layout-transport-fixture';let generation=0;
  const frame=(sequence:number,type:string,payload:unknown)=>`data: ${JSON.stringify({sessionId:id,sequence,type,at:'1970-01-01T00:00:00.000Z',payload})}\n\n`;
  await page.route('**/api/worldstream/sessions',route=>{generation++;return route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`}});});
  await page.route(`**/api/worldstream/sessions/${id}/events*`,route=>{
    // Keep the resumed request pending until the user's abort. Replaying a
    // closed fixture four times would exhaust the real client's resume budget.
    if(generation===1 && new URL(route.request().url()).searchParams.get('since')==='2')return;
    return route.fulfill({contentType:'text/event-stream',body:generation===1
    ?frame(1,'intent.ready',plan.intent)+frame(2,'visual.preview',{preview:built.preview,attempt:0})
    :frame(1,'blueprint.ready',{blueprint:DEMO_BLUEPRINT})+frame(2,'session.complete',{})});
  });
  await page.goto('/studio');await page.getByTestId('prompt-input').fill(plan.intent.setting);await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('visual-preview-notice')).toHaveAttribute('data-stage','intent-layout',{timeout:30_000});
  await expect(page.getByTestId('visual-preview-notice')).toContainText('Provisional layout from your plan');
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().map(s=>s.stableId).sort())).toEqual(objects.map(o=>o.stableId).sort());
  await expect(page.getByTestId('runtime-controls')).toHaveCount(0);await expect(page.getByTestId('world-live-origin')).toHaveCount(0);
  await expect(page.getByTestId('prompt-submit')).toBeDisabled();
  await page.screenshot({path:info.outputPath('intent-layout.png')});
  await page.getByTestId('world-cancel').click();
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  await page.getByTestId('prompt-input').fill('Next accepted fixture');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible({timeout:30_000});
  await expect(page.getByTestId('visual-preview-notice')).toHaveCount(0);
});
