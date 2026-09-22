import {test,expect} from '@playwright/test';
import {buildMassingPreview,WORD_MASSING_NOTICE} from '../src/scene/massing-preview';
import {wordMassing} from '../src/scene/word-massing';
import type {PlannerEmission} from '../src/model/worldstream-intent';

/**
 * **Bloky ze slov věty stojí dřív, než plánovač odpoví, a po jeho odpovědi
 * nezůstane ani jeden** (P21 T4).
 *
 * Dvojník upstreamu je transportní jako u ostatních worldstream specek
 * (`intent-layout-preview.spec.ts`): `page.route` nad `/events`. Serverová
 * část (že `runGeneration` rámec ze slov vydá jako první) je pinnutá
 * v `src/worldstream/__tests__/sessions.test.ts`; tady se měří **klient**.
 *
 * Zpoždění 3 s: první odpověď proudu nese jen rámec ze slov a zavře se,
 * klient naváže (`since=1`) a ta druhá odpověď se drží tři vteřiny, než vydá
 * `intent.ready` a plánovačský hmotový náhled. `plannerAnswered` říká, jestli
 * se hláška ze slov stihla ukázat **před** tou odpovědí — kdyby ne, porotce
 * by ji neviděl ani na nasazení.
 */
const PLANNER_DELAY_MS=3_000;

test('word-guessed blocks and their notice show before the planner answers and vanish after it',async({page},info)=>{
  const sentence='A cabin with a table and two chairs';
  const guessed=wordMassing(sentence,{sessionSeed:4021});if(guessed===null)throw new Error('the fixture sentence yields no word massing');
  const word=buildMassingPreview(guessed,{sessionSeed:4021,notice:WORD_MASSING_NOTICE});if(!word.ok)throw new Error(JSON.stringify(word));
  const wordIds=word.preview.objects.map(o=>o.stableId);
  expect(wordIds.length).toBeGreaterThan(0);expect(wordIds.every(id=>id.startsWith('word-'))).toBe(true);

  const objects=[{stableId:'cabin',label:'Alpine cabin',role:'architecture' as const},{stableId:'table',label:'Wooden table',role:'prop' as const},
    {stableId:'chairA',label:'Chair',role:'prop' as const},{stableId:'chairB',label:'Chair',role:'prop' as const}].map(o=>({...o,synonyms:[],importance:2 as const}));
  const plan:PlannerEmission={intent:{setting:sentence,mood:'calm',spatialThesis:'Two chairs at the table inside the cabin',actors:[],heroObjects:['table'],interactions:[],unsupported:[]},objects};
  const planner=buildMassingPreview(plan,{sessionSeed:4021});if(!planner.ok)throw new Error(JSON.stringify(planner));

  const id='word-massing-transport-fixture';let plannerAnswered=false;
  const frame=(sequence:number,type:string,payload:unknown)=>`data: ${JSON.stringify({sessionId:id,sequence,type,at:'1970-01-01T00:00:00.000Z',payload})}\n\n`;
  await page.route('**/api/worldstream/sessions',route=>route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`}}));
  await page.route(`**/api/worldstream/sessions/${id}/events*`,async route=>{
    const since=new URL(route.request().url()).searchParams.get('since')??'0';
    if(since==='0')return route.fulfill({contentType:'text/event-stream',body:frame(1,'visual.preview',{preview:word.preview,attempt:0})});
    if(since==='1'){
      await new Promise(resolve=>setTimeout(resolve,PLANNER_DELAY_MS));
      plannerAnswered=true;
      return route.fulfill({contentType:'text/event-stream',body:frame(2,'intent.ready',plan.intent)+frame(3,'visual.preview',{preview:planner.preview,attempt:0})});
    }
    // Další navázání se drží otevřené: stav má stát, ne skončit.
  });

  await page.goto('/studio');await page.getByTestId('prompt-input').fill(sentence);await page.getByTestId('prompt-submit').click();

  // Před odpovědí plánovače: hláška ze slov a jen identity `word-`.
  await expect(page.getByTestId('word-massing-notice')).toBeVisible({timeout:30_000});
  expect(plannerAnswered,'the word notice appeared only after the planner had answered').toBe(false);
  await expect(page.getByTestId('word-massing-notice')).toHaveText(WORD_MASSING_NOTICE);
  const early=await page.evaluate(()=>window.__worldstreamStage?.slots().map(s=>s.stableId)??[]);
  expect(early.length).toBeGreaterThan(0);expect(early.every(stableId=>stableId.startsWith('word-'))).toBe(true);
  expect(plannerAnswered).toBe(false);
  await page.screenshot({path:info.outputPath('word-massing-before.png')});

  // Po ní: hláška pryč, na jevišti identity plánovače a žádná `word-`.
  await expect(page.getByTestId('word-massing-notice')).toHaveCount(0,{timeout:30_000});
  await expect(page.getByTestId('visual-preview-notice')).toContainText('Provisional layout from your plan');
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().map(s=>s.stableId).sort())).toEqual(objects.map(o=>o.stableId).sort());
  const late=await page.evaluate(()=>window.__worldstreamStage?.slots().map(s=>s.stableId)??[]);
  expect(late.some(stableId=>stableId.startsWith('word-'))).toBe(false);
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state','preview');
  await page.screenshot({path:info.outputPath('word-massing-after.png')});
});
