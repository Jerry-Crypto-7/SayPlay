import {test,expect} from '@playwright/test';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {recordLiveA4} from './live-a4-recording';
import type {WorldstreamBlueprint} from '../src/worldstream/schema';

test.use({video:process.env.P20_LIVE_EDIT==='1'?'on':'off'});

/** Explicit opt-in paid/subscription transport experiment. Never part of routine e2e. */
test('measures one real main-page generation without routes, fixtures or fallback',async({page},info)=>{
  test.skip(process.env.P20_LIVE_BROWSER!=='1','Requires explicit live experiment configuration');
  test.setTimeout(process.env.P20_LIVE_EDIT==='1'?1_260_000:900_000);
  const folder=process.env.P20_LIVE_BROWSER_DIR;
  if(!folder||existsSync(folder))throw new Error('Use a new explicit P20_LIVE_BROWSER_DIR');
  mkdirSync(folder,{recursive:true});
  const prompt='A small reading room with one glass aquarium, two seated people facing the aquarium, and a computer terminal that switches on a signal light.';
  const errors:string[]=[],requests:unknown[]=[];
  let sessionId:string|null=null;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    if(response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/worldstream/sessions') {
      sessionId=response.headers()['x-worldstream-session']??sessionId;
      requests.push({url:response.url(),status:response.status(),sessionId,authored:response.headers()['x-worldstream-authored']??null});
    }
  });
  await page.addInitScript(()=>{
    const timing={submitted:null as number|null,intent:null as number|null,preview:null as number|null,interactive:null as number|null};
    (window as unknown as {__p20BrowserTiming:typeof timing}).__p20BrowserTiming=timing;
    document.addEventListener('submit',event=>{if((event.target as HTMLElement)?.dataset.testid==='prompt-form')timing.submitted=performance.now();},true);
    document.addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>{
      if(timing.submitted===null)return;
      const at=performance.now()-timing.submitted;
      if(timing.intent===null&&document.querySelector('[data-testid="world-intent"]'))timing.intent=at;
      if(timing.preview===null&&document.querySelector('[data-testid="visual-preview-notice"]'))timing.preview=at;
      if(timing.interactive===null&&document.querySelector('[data-testid="runtime-controls"]'))timing.interactive=at;
    }).observe(document.documentElement,{subtree:true,childList:true,attributes:true}));
  });
  await page.setViewportSize({width:1920,height:1080});await page.goto('/studio');
  await page.getByTestId('prompt-input').fill(prompt);await page.getByTestId('prompt-submit').click();
  const previewCapture=page.getByTestId('visual-preview-notice').waitFor({state:'visible',timeout:850_000})
    .then(async()=>{await page.screenshot({path:join(folder,'first-preview.png')});return true;}).catch(()=>false);
  await expect(page.getByTestId('prompt-submit')).toBeDisabled();
  await expect(page.getByTestId('prompt-submit')).toBeEnabled({timeout:850_000});
  await page.screenshot({path:join(folder,'main-page.png')});
  const measured=await page.evaluate(()=>({timing:(window as unknown as {__p20BrowserTiming:unknown}).__p20BrowserTiming,
    metrics:window.__worldstreamMetrics?.snapshot(),stage:window.__worldstreamStage?{slots:window.__worldstreamStage.slots(),quality:window.__worldstreamStage.quality(),visibility:window.__worldstreamStage.visibility()}:null,
    status:document.querySelector('[data-testid="world-status"]')?.textContent??document.querySelector('[data-testid="world-broken"]')?.textContent,
    interactive:!!document.querySelector('[data-testid="runtime-controls"]'),preview:!!document.querySelector('[data-testid="visual-preview-notice"]'),
    environment:{userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight}}));
  if((measured.timing as {preview:number|null}).preview!==null)await previewCapture;
  let snapshot:unknown=null;
  if(sessionId){const response=await page.request.get(`/api/worldstream/sessions/${sessionId}`);snapshot={status:response.status(),body:await response.json()};}
  writeFileSync(join(folder,'result.json'),JSON.stringify({measuredAt:new Date().toISOString(),prompt,provenance:'live browser production main path; no mocked network',
    cache:'new browser context, production process state recorded separately; not a complete cold/warm experiment',measured,requests,snapshot,errors,
    interpretation:'One observation, not p95 or human recognition evidence. A failed generation remains failed even when this measurement test completes.'},null,2));
  if(process.env.P20_LIVE_EDIT==='1'){
    writeFileSync(join(folder,'video.json'),JSON.stringify({path:await page.video()?.path(),playwrightOutput:info.outputDir,note:'Full browser video finalized when context closes; generation result remains separate.'},null,2));
    const body=(snapshot as {body?:{blueprint?:WorldstreamBlueprint}}|null)?.body;
    await recordLiveA4(page,folder,measured.interactive&&await page.getByTestId('world-live-origin').count()===1?body?.blueprint??null:null);
    if(process.env.P20_LIVE_REQUIRE_A4==='1')
      expect(JSON.parse(readFileSync(join(folder,'a4-result.json'),'utf8')).status,'The entire live A4 path must finish; generation alone is insufficient').toBe('passed');
  }
  expect(requests.length).toBe(1);expect(errors).toEqual([]);
});
