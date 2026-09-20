import {test,expect} from '@playwright/test';

test('three render zones release detail and preserve semantic wrappers on repeated visits',async({page},testInfo)=>{
  test.setTimeout(120_000);
  const errors:string[]=[],requests:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\.(glb|ktx2|png|jpg)(\?|$)/.test(request.url()))requests.push(request.url());});
  await page.goto('/dev/asset-hot-swap?zones=1');
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().length??0)).toBe(6);
  const identities=await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>({id:s.stableId,wrapper:s.objectId,transform:s.transform,sockets:s.sockets})));
  await page.getByRole('button',{name:'Interact',exact:true}).click();
  const state=await page.getByTestId('runtime-state').textContent();
  const samples:unknown[]=[];
  for(const zone of [1,2,3,1,2,3,1]) {
    await page.getByRole('button',{name:`Zone ${zone}`,exact:true}).click();
    const ids=[`listener${(zone-1)*2+1}`,`listener${(zone-1)*2+2}`];
    await expect.poll(()=>page.evaluate(ids=>{
      const probe=window.__worldstreamStage!;return {suspended:probe.streaming().suspended.length,ready:probe.slots().filter(s=>ids.includes(s.stableId)).every(s=>s.rung==='g3-ready'&&s.contentHash!==null)};
    },ids),{timeout:20_000}).toEqual({suspended:4,ready:true});
    const sample=await page.evaluate(()=>({streaming:window.__worldstreamStage!.streaming(),memory:window.__worldstreamStage!.memory()}));
    expect(sample.streaming.cacheEntries).toBeLessThanOrEqual(2);samples.push(sample);
    expect(await page.evaluate(()=>window.__worldstreamStage!.slots().map(s=>({id:s.stableId,wrapper:s.objectId,transform:s.transform,sockets:s.sockets})))).toEqual(identities);
    expect(await page.getByTestId('runtime-state').textContent()).toBe(state);
  }
  await testInfo.attach('zone-lifecycle.json',{body:JSON.stringify({samples,requests},null,2),contentType:'application/json'});
  await page.screenshot({path:testInfo.outputPath('zone-return.png')});expect(errors).toEqual([]);
});
