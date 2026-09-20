import {expect,type Page} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {WorldstreamBlueprint} from '../src/worldstream/schema';

/** Real UI only. Discovery can decline; it never invents a replacement world. */
export async function recordLiveA4(page:Page,folder:string,blueprint:WorldstreamBlueprint|null){
  const started=Date.now(),network:unknown[]=[],pending:Promise<void>[]=[];
  const report:Record<string,unknown>={status:'not-applicable',startedAt:new Date().toISOString(),network,
    modelBudget:'One edit call; ambiguity resolution is non-model. Server must independently enforce total request call cap 4.',
    provenance:'Actual generated blueprint and UI input/rewind/preview/commit; no fixture, injected patch or retry.'};
  const save=()=>writeFileSync(join(folder,'a4-result.json'),JSON.stringify({...report,totalMs:Date.now()-started},null,2));
  page.on('response',response=>{
    if(response.request().method()!=='POST'||!new URL(response.url()).pathname.includes('/changes'))return;
    pending.push((async()=>{const body=await response.text().catch(error=>String(error));network.push({url:response.url(),status:response.status(),request:response.request().postData(),body,atMs:Date.now()-started});save();})());
  });
  try{
    if(!blueprint){report.reason='Generation has no accepted blueprint';return;}
    type Rule={event:{kind:string;actor?:string;actionId?:string;target?:string};actions:{kind:string;flag?:string;ref?:string;value?:unknown}[]};
    const candidates=Object.entries(blueprint.world.sim.rules as Record<string,unknown>).flatMap(([id,raw])=>{
      const rule=raw as unknown as Rule,event=rule.event;
      if(event.kind!=='onAction'||!event.target||!event.actor||!event.actionId)return [];
      const object=blueprint.objects.find(o=>o.binding?.entityId===event.target||o.stableId===event.target);
      if(!object||!(/terminal|computer/i.test([object.label,...object.synonyms].join(' '))))return [];
      const signals=rule.actions.filter(a=>a.kind==='setFlag'&&a.value===true&&/signal|light|lamp/i.test(a.flag??a.ref??''));
      return signals.length===1?[{id,event,object,signal:(signals[0].flag??signals[0].ref)!}]:[];
    });
    report.candidates=candidates;
    if(candidates.length!==1){report.reason=`Expected one terminal action turning an existing signal on, found ${candidates.length}`;return;}
    const chosen=candidates[0];report.selected=chosen;
    if(await page.getByTestId('runtime-state').textContent()!=='running'||!await page.getByTestId('runtime-act').isEnabled()){
      report.reason='Generated runtime is not accepting a supported branch input';return;
    }
    const label=`${chosen.event.actionId} ${chosen.event.target} (${chosen.event.actor})`;
    await page.getByTestId('runtime-action').selectOption({label});
    await page.getByTestId('runtime-act').click();
    const applied=await page.getByTestId('runtime-input-result').textContent();report.actionResult=applied;
    if(!applied?.includes(chosen.id)){report.reason='Existing terminal action did not fire its signal rule; no navigation guessing or retries';return;}
    await expect(page.getByTestId(`runtime-value-f:${chosen.signal}`)).toContainText(': on');
    await page.screenshot({path:join(folder,'a4-action.png')});
    await page.getByTestId('rewind-before-action').click();
    await page.screenshot({path:join(folder,'a4-rewind.png')});
    const prompt=`Change ${chosen.object.label} so its ${chosen.event.actionId} action switches the existing ${chosen.signal} signal off instead of on. Change only that one action; preserve all other rules and objects.`;
    report.prompt=prompt;report.status='running';save();
    const previewAt=Date.now();
    await page.getByTestId('refine-input').fill(prompt);await page.getByTestId('refine-submit').click();
    const panel=page.getByTestId('change-preview');
    await expect(panel).toBeVisible({timeout:260_000});
    if(await panel.getAttribute('data-kind')==='candidates'){
      const candidate=page.getByTestId('change-candidate').filter({hasText:chosen.object.label});
      if(await candidate.count()!==1||await candidate.getAttribute('data-stable-id')!==chosen.object.stableId)throw new Error('Grounding candidates do not contain a unique exact intended semantic object');
      await candidate.click();
    }
    await expect(panel).toHaveAttribute('data-kind',/preview|refused/,{timeout:260_000});
    report.previewMs=Date.now()-previewAt;report.previewText=await panel.textContent();
    await page.screenshot({path:join(folder,'a4-preview.png')});
    if(await panel.getAttribute('data-kind')==='refused'){report.status='rejected';report.reason=await page.getByTestId('change-refusal').textContent();return;}
    await expect(page.getByTestId('change-target')).toHaveText(chosen.object.label);
    await expect(page.getByTestId('change-scope')).toHaveText('This changes 1 behaviour change.');
    const commitAt=Date.now();await page.getByTestId('change-apply').click();
    await expect(page.getByTestId('future-views')).toBeVisible({timeout:30_000});
    await expect(page.getByTestId('future-views').locator('canvas')).toHaveCount(2);
    await expect(page.getByTestId(`branch-value-f:${chosen.signal}`).locator('td')).toHaveText(['on','off']);
    report.commitAndPresentMs=Date.now()-commitAt;
    report.horizon=await page.getByTestId('branch-horizon').textContent();
    await page.screenshot({path:join(folder,'a4-two-futures.png')});report.status='passed';
  }catch(error){report.status='failed';report.reason=String(error);await page.screenshot({path:join(folder,'a4-failure.png')}).catch(()=>{});}
  finally{await Promise.all(pending);save();}
}
