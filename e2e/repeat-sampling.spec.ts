import {test,expect} from '@playwright/test';
import {repeatWorld} from './fixtures/repeat-world';

test('main-page compiler fixture samples one repeated unit and retains one semantic identity',async({page},info)=>{
  const blueprint=repeatWorld(),id='repeat-compiler-fixture';
  // Explicit authored fixture response to the first live request; no model call.
  await page.route('**/api/worldstream/sessions',route=>route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`,authored:{match:'exact'}}}));
  await page.route(`**/api/worldstream/sessions/${id}/events*`,route=>route.fulfill({contentType:'text/event-stream',body:
    `data: ${JSON.stringify({sessionId:id,sequence:1,type:'blueprint.ready',at:'1970-01-01T00:00:00.000Z',payload:{blueprint}})}\n\n`+
    `data: ${JSON.stringify({sessionId:id,sequence:2,type:'session.complete',at:'1970-01-01T00:00:00.000Z',payload:{}})}\n\n`}));
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByTestId('prompt-input').fill('Explicit repeat compiler fixture');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible({timeout:30_000});
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().find(s=>s.stableId==='fins')?.samplingAction?.kind),{timeout:30_000}).toBe('repeat-instanced');
  const slots=await page.evaluate(()=>window.__worldstreamStage!.slots());
  expect(slots.filter(s=>s.stableId==='fins')).toHaveLength(1);
  expect(slots.find(s=>s.stableId==='fins')?.internalInstances).toBe(2);
  expect(slots.find(s=>s.stableId==='fins')?.detailAssessment?.status).toBe('sampling-risk');
  await expect(page.getByTestId('world-live-origin')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('repeat-instanced-main.png')});
  await page.getByRole('button',{name:'Inspect',exact:true}).click();
  await page.getByTestId('inspect-visibility').click();
  await expect(page.getByTestId('shape-detail-report')).toContainText('fins');
  await expect(page.getByTestId('shape-detail-report')).toContainText('Shape sampling diagnostics');
  await expect(page.getByTestId('shape-detail-report')).toContainText('Applied: Meshed one bounded unit; 2 internal instances');
  await page.screenshot({path:info.outputPath('repeat-sampling-inspect.png')});
  // The sparse shape's sampled rays miss its two thin units. The diagnostic
  // offers one camera-only inspection rather than claiming recognition.
  const identities=slots.map(s=>({id:s.objectId,stableId:s.stableId,transform:s.transform}));
  const inspection=page.getByRole('button',{name:'Inspect this object',exact:true});
  await expect(inspection).toHaveCount(1);
  await inspection.click();await expect(inspection).toBeDisabled();
  expect(await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>({id:s.objectId,stableId:s.stableId,transform:s.transform})))).toEqual(identities);
  await page.getByTestId('inspect-visibility').click();
  await expect(page.getByTestId('visibility-report')).toContainText('Recognition still needs human review');
  await page.getByTestId('inspect-toggle').click();await page.getByTestId('inspect-toggle').click();
  await page.getByTestId('inspect-visibility').click();
  await expect(page.getByRole('button',{name:'Inspect this object',exact:true})).toBeDisabled();
  await page.screenshot({path:info.outputPath('repeat-targeted-inspection.png')});
  expect(errors).toEqual([]);
});
