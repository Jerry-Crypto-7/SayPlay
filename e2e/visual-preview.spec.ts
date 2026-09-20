import {test,expect} from '@playwright/test';
import {DEMO_BLUEPRINT} from '../src/app/dev/demo-world';
import {visualPreviewSchema} from '../src/worldstream/schema';

test('rejected rules retain a noninteractive authored preview; next accepted world enables runtime',async({page},info)=>{
  const id='preview-fixture';let requests=0;
  const preview=visualPreviewSchema.parse({kind:'visual-preview',interactive:false,
    version:DEMO_BLUEPRINT.version,sessionSeed:DEMO_BLUEPRINT.sessionSeed,title:DEMO_BLUEPRINT.title,
    intent:DEMO_BLUEPRINT.intent,geometry:DEMO_BLUEPRINT.geometry,objects:DEMO_BLUEPRINT.objects.map(o=>{
      if(!o.binding)return o;const {entityId,signalFlag,...binding}=o.binding;return {...o,binding};
    }),shapes:DEMO_BLUEPRINT.shapes,look:DEMO_BLUEPRINT.world.look,
    validation:{layout:'not-requested',limitations:['Scripted transport fixture; not live generation.']}});
  const frame=(sequence:number,type:string,payload:unknown)=>`data: ${JSON.stringify({sessionId:id,sequence,type,at:'1970-01-01T00:00:00.000Z',payload})}\n\n`;
  await page.route('**/api/worldstream/sessions',route=>{requests++;return route.fulfill({status:202,json:{sessionId:id,events:`/api/worldstream/sessions/${id}/events`,snapshot:`/api/worldstream/sessions/${id}`}});});
  await page.route(`**/api/worldstream/sessions/${id}/events*`,route=>route.fulfill({contentType:'text/event-stream',body:requests===1
    ?frame(1,'intent.ready',preview.intent)+frame(2,'visual.preview',{preview,attempt:1})+frame(3,'session.failed',{reason:'No verified rules.',code:'BLUEPRINT_REJECTED'})
    :frame(1,'blueprint.ready',{blueprint:DEMO_BLUEPRINT})+frame(2,'session.complete',{})}));
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByTestId('prompt-input').fill('Preview fixture');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('visual-preview-notice')).toBeVisible({timeout:30_000});
  await expect.poll(()=>page.evaluate(()=>window.__worldstreamStage?.slots().length??0)).toBeGreaterThan(0);
  await expect(page.getByTestId('runtime-controls')).toHaveCount(0);await expect(page.getByTestId('refine-form')).toHaveCount(0);
  await expect(page.getByTestId('world-live-origin')).toHaveCount(0);
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state','preview');
  await page.screenshot({path:info.outputPath('rejected-rules-preview.png')});
  await page.getByTestId('prompt-input').fill('Accepted fixture');await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible({timeout:30_000});
  await expect(page.getByTestId('visual-preview-notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});
