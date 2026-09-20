import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import template from './human-review.template.json';
import {runHumanReview,reviewStatus} from './human-review-runner';

it('archives an empty template as INVALID without inventing people or modifying input',()=>{
  const root=mkdtempSync(join(tmpdir(),'p20-human-')),input=join(root,'study.json'),output=join(root,'report');
  const bytes=Buffer.from(JSON.stringify(template));writeFileSync(input,bytes);
  const result=runHumanReview(input,output);
  expect(result.status).toBe('INVALID');expect(result.provenance.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(readFileSync(input)).toEqual(bytes);expect(readFileSync(join(output,'input.json'))).toEqual(bytes);
  const report=readFileSync(join(output,'summary.json'));
  expect(()=>runHumanReview(input,output)).toThrow();expect(readFileSync(join(output,'summary.json'))).toEqual(report);
});
it('reports a complete manifest without any participants or answers as PENDING',()=>{
  const root=mkdtempSync(join(tmpdir(),'p20-human-')),input=join(root,'study.json');
  writeFileSync(input,JSON.stringify({...template,runId:'runner-only-no-human-study',buildHash:'a'.repeat(64),datasetHash:'b'.repeat(64)}));
  const result=runHumanReview(input,join(root,'report'));
  expect(result.status).toBe('PENDING');expect(Object.values(result.aggregate.gates)).toEqual(['PENDING','PENDING','PENDING']);
});
it('reports malformed JSON as INVALID and refuses oversized input before creating output',()=>{
  const root=mkdtempSync(join(tmpdir(),'p20-human-')),input=join(root,'study.json');writeFileSync(input,'{');
  expect(runHumanReview(input,join(root,'invalid')).status).toBe('INVALID');
  writeFileSync(input,' '.repeat(2*1024*1024+1));
  expect(()=>runHumanReview(input,join(root,'oversized'))).toThrow('2 MiB');expect(existsSync(join(root,'oversized'))).toBe(false);
});
it('does not conflate failed or incomplete gates with successful runner execution',()=>{
  expect(reviewStatus({a:'PASS',b:'PASS'})).toBe('PASS');expect(reviewStatus({a:'PASS',b:'PENDING'})).toBe('PENDING');
  expect(reviewStatus({a:'FAIL',b:'PENDING'})).toBe('FAIL');expect(reviewStatus({a:'FAIL',b:'INVALID'})).toBe('INVALID');
});
