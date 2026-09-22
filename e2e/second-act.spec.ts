import {expect,test,type Page} from '@playwright/test';
import {doorWorld} from './fixtures/door-world';
const AUTHORED='A bridge town: houses hanging under a single span over a dry canyon.';
const REFINE='Make the hanging houses bigger and let them sway.';
const WORLD_BUDGET_MS=90_000;
async function buildWorld(page:Page,sentence:string){
  await page.getByTestId('prompt-input').fill(sentence);await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state','live',{timeout:WORLD_BUDGET_MS});
}
async function holdPreparedCommit(page:Page){
  let release=()=>{},held=false;const gate=new Promise<void>(resolve=>{release=resolve;});const urls:string[]=[];
  page.on('request',request=>urls.push(request.url()));
  await page.route('**/api/worldstream/sessions',route=>{expect(route.request().postDataJSON().live).not.toBe(true);return route.fallback();});
  await page.route('**/changes/*/commit',async route=>{if(held)await gate;return route.fallback();});
  return {urls,hold:()=>{held=true;},releaseCommit:()=>{held=false;release();}};
}
async function fixtureTransport(page:Page,{holdFirst=false,failFirst=false}={}){
  const requests:{prompt:string;live?:boolean}[]=[],blueprint=doorWorld();let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/worldstream/sessions',route=>{
    requests.push(route.request().postDataJSON());const id=`mode-fixture-${requests.length}`;
    if(failFirst&&requests.length===1)return route.fulfill({status:503,json:{error:{code:'LIVE_UNAVAILABLE',message:'Explicit live failure'}}});
    return route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`,authored:{match:'exact'}}});
  });
  await page.route('**/api/worldstream/sessions/mode-fixture-*/events*',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').at(-2)!;
    if(holdFirst&&id==='mode-fixture-1')await gate;
    const frame=(sequence:number,type:string,payload:unknown)=>`data: ${JSON.stringify({sessionId:id,sequence,type,at:'1970-01-01T00:00:00.000Z',payload})}\n\n`;
    await route.fulfill({contentType:'text/event-stream',body:frame(1,'blueprint.ready',{blueprint})+frame(2,'session.complete',{})}).catch(()=>{});
  });return {requests,release};
}
test('prepared mode preserves visitor input and slot identity without automatic replacement',async({page})=>{
  const transport=await fixtureTransport(page);await page.goto('/studio');
  await page.getByTestId('generation-mode').selectOption('prepared');await buildWorld(page,'Explicit prepared fixture');
  await page.getByTestId('runtime-action').selectOption({label:'activate gate (visitor)'});await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('open');await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  const ids=await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>s.objectId));
  await page.getByTestId('rewind-before-action').click();
  expect(await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>s.objectId))).toEqual(ids);
  expect(transport.requests).toEqual([{prompt:'Explicit prepared fixture'}]);
  await expect(page.getByTestId('world-authored')).toBeVisible();await expect(page.getByTestId('second-act-offer')).toHaveCount(0);
});
test('cancelled pending live generation cannot replace a newer prepared session',async({page})=>{
  const transport=await fixtureTransport(page,{holdFirst:true});await page.goto('/studio');
  await page.getByTestId('prompt-input').fill('Pending own world');await page.getByTestId('prompt-submit').click();
  await expect.poll(()=>transport.requests.length).toBe(1);await page.getByTestId('world-cancel').click();
  await page.getByTestId('generation-mode').selectOption('prepared');await buildWorld(page,'New prepared choice');
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();const ids=await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>s.objectId));
  transport.release();await page.waitForTimeout(150);
  expect(await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>s.objectId))).toEqual(ids);
  expect(transport.requests).toEqual([{prompt:'Pending own world',live:true},{prompt:'New prepared choice'}]);
  await expect(page.getByTestId('world-authored')).toBeVisible();await expect(page.getByTestId('refine-submit')).toBeEnabled();
});
test('live failure stays failed until the user explicitly requests a prepared demo',async({page})=>{
  const transport=await fixtureTransport(page,{failFirst:true});await page.goto('/studio');
  await page.getByTestId('prompt-input').fill('Own world');await page.getByTestId('prompt-submit').click();
  await expect(page.getByText(/Explicit live failure/)).toBeVisible();expect(transport.requests).toEqual([{prompt:'Own world',live:true}]);
  await expect(page.getByTestId('runtime-controls')).toHaveCount(0);
  await page.getByTestId('generation-mode').selectOption('prepared');await buildWorld(page,'Explicit recovery demo');
  await expect(page.getByText(/Explicit live failure/)).toHaveCount(0);
  expect(transport.requests).toEqual([{prompt:'Own world',live:true},{prompt:'Explicit recovery demo'}]);await expect(page.getByTestId('world-authored')).toBeVisible();
});
// Historical filename; explicit P20 modes replace automatic second act.
test('nová věta během potvrzování změny odemkne úpravy nového světa', async ({ page }) => {
  test.setTimeout(180_000);
  const acts = await holdPreparedCommit(page);

  await page.goto('/studio');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await buildWorld(page, AUTHORED);
  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview', {
    timeout: WORLD_BUDGET_MS,
  });

  acts.hold();
  await page.getByTestId('change-apply').click();
  await expect.poll(() => acts.urls.some((url) => url.includes('/commit'))).toBe(true);

  // Nová relace invaliduje starý commit. Jeho finally už nesmí zapisovat do UI,
  // takže odemknutí musí patřit začátku nové relace, ne staré odpovědi.
  await buildWorld(page, AUTHORED);
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  acts.releaseCommit();

  // Ověříme i skutečnou další operaci; samotný vzhled tlačítka není důkaz,
  // že requestChange používá nový svět a že jej stará odpověď nepřepsala.
  await page.getByTestId('refine-input').fill(REFINE);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview', {
    timeout: WORLD_BUDGET_MS,
  });
});
