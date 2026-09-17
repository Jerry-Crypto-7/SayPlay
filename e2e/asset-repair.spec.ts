import {test,expect,type Page} from '@playwright/test';
import catalog from '../src/assets/catalog.json';
import {DEMO_BLUEPRINT} from '../src/app/dev/demo-world';
import {blueprintSchema} from '../src/worldstream/schema';
import {openInspect} from './inspect';

const asset=catalog.assets.find(item=>item.assetId==='seated-person')!;
const provenance={kind:'inferred' as const,reason:'Explicit accepted asset-load failure fixture, not live model evidence'};
const blueprint=blueprintSchema.parse({...DEMO_BLUEPRINT,version:'worldstream-v2',title:'Approved seated-person retry fixture',shapes:[],
  geometry:{version:DEMO_BLUEPRINT.geometry.version,nodes:[{kind:'terrain',variant:'flat',extent:[4,4],amplitude:0,seed:1}],root:0},
  objects:[{stableId:'floor',label:'Flat floor',synonyms:[],role:'terrain',importance:1,source:{kind:'geom',node:0},targetBounds:{min:[-2,-0.01,-2],max:[2,0.01,2]}},
    {stableId:'listener',label:'Seated person',synonyms:[],role:'hero',importance:3,
      source:{kind:'asset',assetId:asset.assetId,version:asset.version,hash:asset.hash},targetBounds:asset.bounds,
      binding:{entityId:'keeper',collider:asset.bounds,sockets:asset.sockets,parts:[]}}],
  sceneSpec:{version:1,clarifications:[],relations:[],
    requirements:[{id:'floor',description:'Flat floor',priority:'main',polarity:'required',count:1,instanceIds:['floor'],provenance},
      {id:'listener',description:'One seated person',priority:'main',polarity:'required',count:1,instanceIds:['listener'],provenance}],
    instances:[{stableId:'floor',role:'terrain',requirementIds:['floor'],provenance,attributes:[],orientation:{description:'Flat',provenance}},
      {stableId:'listener',role:'hero',requirementIds:['listener'],provenance,attributes:[],orientation:{description:'Upright',provenance}}]}});

async function openFailedAsset(page:Page,permanent=false){
  let attempts=0,posts=0,release:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/*.glb',async route=>{
    attempts++;
    if(attempts===1||permanent)return route.abort('failed');
    await held;await route.continue();
  });
  await page.route('**/api/worldstream/sessions',route=>{posts++;return route.fulfill({status:202,json:{sessionId:'asset-repair-fixture',events:'/api/worldstream/sessions/asset-repair-fixture/events'}});});
  const frame=(sequence:number,type:string,payload:unknown)=>`data: ${JSON.stringify({sessionId:'asset-repair-fixture',sequence,type,payload,at:'1970-01-01T00:00:00.000Z'})}\n\n`;
  await page.route('**/api/worldstream/sessions/asset-repair-fixture/events*',route=>route.fulfill({contentType:'text/event-stream',body:frame(1,'blueprint.ready',{blueprint})+frame(2,'session.complete',{})}));
  await page.goto('/');await page.getByTestId('prompt-input').fill('Explicit approved asset failure fixture');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible();
  if(await page.getByTestId('runtime-act').isEnabled())await page.getByTestId('runtime-act').click();
  if(await page.getByTestId('runtime-pause').isEnabled())await page.getByTestId('runtime-pause').click();
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().find(s=>s.stableId==='listener')?.assetRetry.status)).toBe('available');
  await openInspect(page);await page.getByTestId('inspect-visibility').click();
  await expect(page.getByTestId('asset-repair-retry')).toBeEnabled();
  return {release,attempts:()=>attempts,posts:()=>posts};
}
async function stableState(page:Page){return page.evaluate(()=>{
  const stage=window.__worldstreamStage!,slot=stage.slots().find(s=>s.stableId==='listener')!;
  return {objectId:slot.objectId,transform:slot.transform,sockets:slot.sockets,camera:stage.camera(),builds:stage.builds(),
    tick:document.querySelector('[data-testid="runtime-tick"]')?.getAttribute('data-tick'),
    positions:document.querySelector('[data-testid="runtime-positions"]')?.textContent,
    outcomes:document.querySelector('[data-testid="runtime-outcomes"]')?.textContent,
    state:document.querySelector('[data-testid="runtime-state"]')?.textContent};
});}

test('Inspect retries only the failed approved asset and preserves live state, identity, sockets and camera',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const fixture=await openFailedAsset(page);const before=await stableState(page);
  await page.screenshot({path:info.outputPath('before-retry.png')});
  await page.getByTestId('asset-repair-retry').click();
  await expect(page.getByTestId('asset-repair-retry')).toBeDisabled();
  await expect.poll(()=>fixture.attempts()).toBe(2);fixture.release();
  await expect(page.getByTestId('asset-repair-status')).toContainText('reloaded');
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage!.slots().find(s=>s.stableId==='listener')!.contentHash)).toBe(asset.lods[0].hash);
  expect(await stableState(page)).toEqual(before);expect(fixture.posts()).toBe(1);expect(fixture.attempts()).toBe(2);
  await page.getByTestId('inspect-toggle').click();await openInspect(page);await page.getByTestId('inspect-visibility').click();
  await expect(page.getByTestId('asset-repair-retry')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__worldstreamStage!.retryAsset('listener'))).toMatchObject({status:'exhausted'});
  expect(fixture.attempts()).toBe(2);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath('after-retry.png')});
});

test('a permanently failed object reports the exhausted attempt after closing and reopening Inspect',async({page},info)=>{
  const fixture=await openFailedAsset(page,true);await page.getByTestId('asset-repair-retry').click();
  await expect(page.getByTestId('asset-repair-status')).toContainText('failed');
  await page.getByTestId('inspect-toggle').click();await openInspect(page);await page.getByTestId('inspect-visibility').click();
  await expect(page.getByTestId('asset-repair-row')).toContainText('exhausted');await expect(page.getByTestId('asset-repair-retry')).toHaveCount(0);
  expect(fixture.attempts()).toBe(2);expect(fixture.posts()).toBe(1);
  expect(await page.evaluate(()=>window.__worldstreamStage!.retryAsset('listener'))).toMatchObject({status:'exhausted'});
  await page.screenshot({path:info.outputPath('exhausted-retry.png')});
});
