import {test,expect} from '@playwright/test';
import sharp from 'sharp';
import {doorWorld} from './fixtures/door-world';

test('compiler opening and GLB hinge follow a verified door rule and rewind on the main page',async({page},info)=>{
  const blueprint=doorWorld(),id='door-compiler-fixture';
  // Explicit authored fixture response to the first live request; no model call.
  await page.route('**/api/worldstream/sessions',route=>route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`,authored:{match:'exact'}}}));
  await page.route(`**/api/worldstream/sessions/${id}/events*`,route=>route.fulfill({contentType:'text/event-stream',body:
    `data: ${JSON.stringify({sessionId:id,sequence:1,type:'blueprint.ready',at:'1970-01-01T00:00:00.000Z',payload:{blueprint}})}\n\n`+
    `data: ${JSON.stringify({sessionId:id,sequence:2,type:'session.complete',at:'1970-01-01T00:00:00.000Z',payload:{}})}\n\n`}));
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByTestId('prompt-input').fill('Door compiler fixture');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible({timeout:30_000});
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().find(s=>s.stableId==='gate')?.contentHash)).toBeTruthy();
  await page.getByTestId('cutaway-toggle').click();
  const canvas=page.getByTestId('worldstream-canvas');
  const closed=await canvas.screenshot();
  const act=async(label:string)=>{
    const option=page.getByTestId('runtime-action').locator('option').filter({hasText:label});
    await page.getByTestId('runtime-action').selectOption((await option.getAttribute('value'))!);await page.getByTestId('runtime-act').click();
  };
  await act('pass gate');await expect(page.getByTestId('runtime-input-result')).toContainText('No rule applied');
  await act('activate gate');await expect(page.getByTestId('runtime-input-result')).toContainText('open');
  await page.waitForTimeout(100); // renderer consumes the accepted snapshot
  const opened=await canvas.screenshot();
  const [a,b]=await Promise.all([closed,opened].map(buffer=>sharp(buffer).removeAlpha().raw().toBuffer()));
  let changed=0;for(let i=0;i<a.length;i+=3)if(Math.max(...[0,1,2].map(c=>Math.abs(a[i+c]-b[i+c])))>20)changed++;
  expect(changed).toBeGreaterThan(100);
  await page.screenshot({path:info.outputPath('door-open.png')});
  await act('pass gate');await expect(page.getByTestId('runtime-state')).toHaveText('won');
  await page.getByTestId('world-time').focus();await page.getByTestId('world-time').press('Home');
  await expect(page.getByTestId('runtime-outcomes')).toContainText('gate: locked');
  await page.screenshot({path:info.outputPath('door-rewound.png')});
  await expect(page.getByTestId('world-live-origin')).toHaveCount(0);
  expect(errors).toEqual([]);
});
