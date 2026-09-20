import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {aggregateHumanReview} from './human-review';

export type ReviewStatus='INVALID'|'PENDING'|'FAIL'|'PASS';
export function reviewStatus(gates:Record<string,string>):ReviewStatus {
  const values=Object.values(gates);
  return values.includes('INVALID')?'INVALID':values.includes('FAIL')?'FAIL':values.includes('PENDING')?'PENDING':'PASS';
}
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Only the explicitly supplied JSON is read. Evidence refs are never followed. */
export function runHumanReview(inputPath:string,outputPath:string){
  if(!inputPath.trim()||!outputPath.trim())throw new Error('Explicit input JSON and NEW output directory required');
  const input=resolve(inputPath),output=resolve(outputPath);
  if(!input.toLowerCase().endsWith('.json'))throw new Error('Input must be an explicit JSON study artifact');
  if(input===output||input.startsWith(output+sep))throw new Error('Output cannot contain the original input');
  const stat=statSync(input);
  if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('Study input must be a regular file at most 2 MiB');
  const bytes=readFileSync(input);if(bytes.length>2*1024*1024)throw new Error('Study input exceeded 2 MiB');
  let value:unknown,parseIssue:string|undefined;
  try{
    value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    // Keep even malformed input bounded before potentially quadratic duplicate checks.
    const pending:unknown[]=[value];let visited=0;
    while(pending.length){const entry=pending.pop();if(++visited>50000)throw new Error('Study input exceeds 50000 values');
      if(entry&&typeof entry==='object'){
        const values=Object.values(entry);
        if(values.length>1000)throw new Error('Study collection exceeds 1000 entries');
        pending.push(...values);
      }
    }
  }catch(error){parseIssue=error instanceof Error?error.message:String(error);}
  const aggregate=parseIssue?{status:'INVALID',issues:[parseIssue],gates:{'G-V':'INVALID','G-W':'INVALID','A4-human':'INVALID'}}:aggregateHumanReview(value);
  const status=reviewStatus(aggregate.gates);
  // Exclusive mkdir and wx writes: never reuse/overwrite a prior study run.
  mkdirSync(output);
  writeFileSync(join(output,'input.json'),bytes,{flag:'wx'});
  const summary={version:'p20-human-review-run-v1',status,createdAt:new Date().toISOString(),
    provenance:{input,sha256:sha256(bytes),bytes:bytes.length,modelCalls:0,networkCalls:0,
      kind:'Offline aggregation of explicitly supplied study records; does not create human evidence.'},aggregate,
    limits:['Evidence references are not opened or authenticated. Verify archived responses and human independence separately.',
      'A successful runner execution is not a passed study gate. INVALID, PENDING and FAIL are legitimate reports.',
      'No model, renderer, latency or public-operation gate is accepted by this workflow.']};
  writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  const report=[`# P20 human review: ${status}`,'',`Input SHA256: \`${summary.provenance.sha256}\``,
    `Input: \`${input}\``, '', '| Gate | Result |','|---|---|',
    ...Object.entries(aggregate.gates).map(([gate,result])=>`| ${gate} | ${result} |`),'',
    'INVALID = malformed or contradictory records; PENDING = missing required evidence; FAIL = evaluated threshold not met; PASS = recorded thresholds met, subject to evidence verification.',
    '', '## Issues',...aggregate.issues.map(issue=>`- ${issue.replace(/[\r\n]/g,' ')}`),
    ...(aggregate.issues.length?[]:['None detected by the schema/aggregator.']), '',
    '## Limits',...summary.limits.map(limit=>`- ${limit}`),'',
    'Machine counts, denominators and individual decisions: `summary.json`. Raw input preserved byte-for-byte: `input.json`.',''].join('\n');
  writeFileSync(join(output,'report.md'),report,{flag:'wx'});
  return summary;
}
