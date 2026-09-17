import {test,expect} from '@playwright/test';

test('compiler-produced fixture renders seated contacts, derived facing and sampled sloped terrain',async({page},testInfo)=>{
  test.setTimeout(90_000);const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('/dev/semantic-layout');
  await expect(page.getByText('Compiler layout fixture · not live generation',{exact:true})).toBeVisible();
  const report=JSON.parse((await page.getByTestId('layout-report').textContent())!);
  expect(report).toMatchObject({objects:12,contacts:4,facing:4});
  expect(report.adjustments.some((line:string)=>line.startsWith('objects/terminal/yaw'))).toBe(true);
  expect(report.adjustments.some((line:string)=>line.includes('unsupported'))).toBe(false);
  await expect.poll(()=>page.evaluate(()=>{
    const slots=window.__worldstreamStage?.slots()??[];
    return {count:slots.length,loaded:slots.filter(s=>s.asset&&s.contentHash&&s.rung==='g3-ready'&&!s.failure).length};
  }),{timeout:30_000}).toEqual({count:12,loaded:9});
  const slots=await page.evaluate(()=>window.__worldstreamStage!.slots());
  expect(slots.filter(s=>s.stableId.startsWith('listener'))).toHaveLength(3);
  for(const person of slots.filter(s=>s.stableId.startsWith('listener'))) {
    expect(person.sockets.map(s=>s.name)).toContain('seat');
    expect(person.transform.translation[1]).toBeLessThan(0.1);
    expect(person.sockets.find(s=>s.name==='seat')!.at[1]).toBeCloseTo(0.565,3);
  }
  expect(slots.find(s=>s.stableId==='terminal')!.transform.rotationY).toBeDefined();
  expect(slots.find(s=>s.stableId==='plant')!.transform.translation[1]).toBeLessThan(0);
  const visibility=await page.evaluate(()=>window.__worldstreamStage!.visibility());
  expect(visibility.filter(v=>v.stableId.startsWith('listener')).some(v=>v.loaded&&v.inFrame&&v.unoccludedSamples>0)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('compiler-layout-seated-terrain.png')});
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage!.cutaway().active)).toBe(true);
  const before=await page.evaluate(()=>({slots:window.__worldstreamStage!.slots(),camera:window.__worldstreamStage!.camera()}));
  await page.getByRole('button',{name:'Show full walls',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage!.cutaway().active)).toBe(false);
  expect(await page.evaluate(()=>({slots:window.__worldstreamStage!.slots(),camera:window.__worldstreamStage!.camera()}))).toEqual(before);
  await page.screenshot({path:testInfo.outputPath('compiler-layout-full-walls.png')});
  await page.getByRole('button',{name:'Cut away walls',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage!.cutaway().active)).toBe(true);
  expect(errors).toEqual([]);
});
