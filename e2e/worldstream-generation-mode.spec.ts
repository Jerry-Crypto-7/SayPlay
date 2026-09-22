import {test,expect} from '@playwright/test';
import {doorWorld} from './fixtures/door-world';

test('own prompt sends one live request and an unavailable model never falls back to a prepared world',async({page})=>{
  const requests:unknown[]=[];
  await page.route('**/api/worldstream/sessions',route=>{
    requests.push(route.request().postDataJSON());
    return route.fulfill({status:503,json:{error:{code:'LIVE_UNAVAILABLE',message:'Explicit test transport refusal'}}});
  });
  await page.goto('/studio');await expect(page.getByTestId('generation-mode')).toHaveValue('live');
  await page.getByTestId('prompt-input').fill('My own room');await page.getByTestId('prompt-submit').click();
  await expect(page.getByText(/Explicit test transport refusal/)).toBeVisible();
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  expect(requests).toEqual([{prompt:'My own room',live:true}]);
  await expect(page.getByTestId('runtime-controls')).toHaveCount(0);
  await expect(page.getByTestId('world-authored')).toHaveCount(0);
  await expect(page.getByTestId('second-act-writing')).toHaveCount(0);
});

test('explicit prepared demo stays in one labelled session without background live replacement',async({page},info)=>{
  const blueprint=doorWorld(),id='explicit-prepared-mode-fixture',requests:unknown[]=[];
  await page.route('**/api/worldstream/sessions',route=>{
    requests.push(route.request().postDataJSON());
    return route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`,authored:{match:'exact'}}});
  });
  await page.route(`**/api/worldstream/sessions/${id}/events*`,route=>route.fulfill({contentType:'text/event-stream',body:
    `data: ${JSON.stringify({sessionId:id,sequence:1,type:'blueprint.ready',at:'1970-01-01T00:00:00.000Z',payload:{blueprint}})}\n\n`+
    `data: ${JSON.stringify({sessionId:id,sequence:2,type:'session.complete',at:'1970-01-01T00:00:00.000Z',payload:{}})}\n\n`}));
  await page.goto('/studio');await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Prepared door example');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible({timeout:30_000});
  await expect(page.getByTestId('runtime-act')).toBeInViewport();
  await expect(page.getByTestId('rewind-before-action')).toBeInViewport();
  await expect(page.getByTestId('prompt-submit')).toBeEnabled({timeout:30_000});
  await expect(page.getByTestId('world-authored')).toBeVisible();
  await expect(page.getByTestId('world-live-origin')).toHaveCount(0);
  await expect(page.getByTestId('second-act-writing')).toHaveCount(0);
  expect(requests).toEqual([{prompt:'Prepared door example'}]);
  await page.screenshot({path:info.outputPath('controls-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  expect((await page.getByTestId('prompt-input').boundingBox())!.width).toBeGreaterThan(180);
  await page.screenshot({path:info.outputPath('controls-mobile.png')});
});
