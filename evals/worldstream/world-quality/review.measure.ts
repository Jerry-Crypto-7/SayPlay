import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {reviewScene} from './review';
import {blueprintSchema} from '../../../src/worldstream/schema';
import {readPlannerEmission} from '../../../src/model/worldstream-intent';

it('writes a new offline review of saved live artifacts without altering historical metrics',()=>{
  const folder=process.env.P20_REVIEW_DIR;if(!folder)throw new Error('Set P20_REVIEW_DIR');
  const read=(name:string)=>JSON.parse(readFileSync(join(folder,name),'utf8').replace(/^\uFEFF/,''));
  const raw=read('planner.json');const plan=readPlannerEmission(raw.value??raw);
  if(!plan.ok)throw new Error(plan.detail);
  const blueprint=blueprintSchema.parse(read('blueprint.json'));
  const report=reviewScene({blueprint,planned:plan.value.objects,provenance:{kind:'replay',artifact:join(folder,'blueprint.json')}});
  writeFileSync(join(folder,'hybrid-offline-review.json'),JSON.stringify(report,null,2),{flag:'wx'});
  expect(report.instances.length).toBeGreaterThan(0);
});
