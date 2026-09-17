/** Read-only finalization of the frozen live run; no model calls or source replay. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {it,expect} from 'vitest';
import {summarizeIntegrated} from './integrated';

it('reports every frozen generation, including failures and missing browser evidence',()=>{
  if(!process.env.P20_T18_RUN_DIR)throw new Error('Set P20_T18_RUN_DIR to a completed run');
  const root=resolve(process.env.P20_T18_RUN_DIR),read=(name:string)=>JSON.parse(readFileSync(join(root,name),'utf8'));
  if(!existsSync(join(root,'completion.json')))throw new Error('Run is still active; do not finalize partial evidence');
  const rows=read('results.json') as {id:string;status:string;intentMs:number|null;totalMs:number|null;calls:number;failure:unknown}[];
  const expected=read('expected-cases.json') as {id:string;prompt:string}[];
  expect(rows.map(r=>r.id)).toEqual(expected.map(r=>r.id));expect(rows).toHaveLength(30);
  const summary=summarizeIntegrated(rows);
  const groups=Object.fromEntries(['development','holdout'].map(group=>{
    const subset=rows.filter(r=>group==='development'?r.id.startsWith('t'):r.id.startsWith('h'));
    return [group,{denominator:subset.length,certified:subset.filter(r=>r.status==='compiled').length,completed:subset.filter(r=>['compiled','rejected','unavailable'].includes(r.status)).length}];
  }));
  const reason=(failure:unknown):string=>{
    if(!failure||typeof failure!=='object')return failure===null?'—':String(failure);
    const f=failure as Record<string,unknown>;
    if(f.fault)return reason(f.fault);
    return [f.reason??f.kind??'unknown',f.detail??f.error??''].filter(Boolean).join(': ');
  };
  const failures=Object.fromEntries([...new Set(rows.filter(r=>r.status!=='compiled').map(r=>reason(r.failure).split(':')[0]))]
    .map(key=>[key,rows.filter(r=>r.status!=='compiled'&&reason(r.failure).split(':')[0]===key).map(r=>r.id)]));
  const reliabilityFailed=summary.certifiedBlueprints+(30-summary.completed)<27;
  const latencyFailed=summary.intent.n===30&&summary.intent.p95Ms!==null&&summary.intent.p95Ms>20_000;
  const report={...summary,
    gates:{...summary.gates,'G-R':reliabilityFailed?'FAIL':summary.gates['G-R'],'G-L':latencyFailed?'FAIL':summary.gates['G-L']},
    gateReasons:{'G-R':reliabilityFailed?'Generation upper bound below 27/30; browser success cannot restore rejected cases.':'Browser live evidence remains required.',
      'G-L':latencyFailed?'Complete planner intent p95 exceeds 20 seconds; missing browser metrics cannot undo this failure.':'Browser latency evidence remains required.'},
    groups,failures,calls:rows.reduce((sum,r)=>sum+r.calls,0),
    reliabilityUpperBound:summary.certifiedBlueprints+(30-summary.completed),
    interpretation:{reliability:summary.certifiedBlueprints+(30-summary.completed)<27?'FAIL: even the generation upper bound is below 27/30. Browser evidence cannot rescue rejected cases.':'Browser live evidence still required.',
      latency:summary.intent.n===30&&summary.intent.p95Ms!>20_000?'FAIL: measured planner intent p95 exceeds 20 seconds. Browser composition/live times remain separate.':'Intent measurement incomplete or within threshold; browser composition/live times still required.',
      provenance:'Frozen source live generation; later solver/runtime changes are separate versions. No human, reference-hardware, remote-asset or public-host PASS inferred.'}};
  writeFileSync(join(root,'final-machine-summary.json'),JSON.stringify(report,null,2));
  const ms=(n:number|null)=>n===null?'nezměřeno':`${(n/1000).toFixed(3)} s`;
  const escape=(s:string)=>s.replaceAll('|','\\|').replaceAll('\n',' ');
  writeFileSync(join(root,'final-report.md'),[
    '# P20 T18 — zmrazená hybridní generace','',
    `Dokončeno ${summary.completed}/30, certifikované blueprinty ${summary.certifiedBlueprints}/30, volání ${report.calls}. Certifikace není browser live ani rozpoznatelnost.`,
    `Intent p95 ${ms(summary.intent.p95Ms)}; dokončení všech případů p95 ${ms(summary.generationCompletion.p95Ms)}, pouze certifikovaných ${ms(summary.certifiedCompletion.p95Ms)}.`,
    '',report.interpretation.reliability,report.interpretation.latency,'',
    '| Případ | Stav | Čas | Volání | Konečný důvod |','|---|---|---:|---:|---|',
    ...rows.map(r=>`| ${r.id} | ${r.status} | ${ms(r.totalMs)} | ${r.calls} | ${escape(reason(r.failure))} |`),'',
    '[Úplný strojový souhrn](final-machine-summary.json), [raw výsledky](results.json), [zdroj a prostředí](environment.json), [browser galerie](gallery.html). Galerie je samostatný krok; odkaz sám není důkaz její existence nebo úspěchu.','',
    'Prompt-to-first-visible/live, cold/warm a nový vzdálený asset nejsou odvozeny z těchto Node časů. Lidské G-V/G-W, cílový notebook, G-E a veřejné G-D zůstávají samostatné. Deset modelových A4 intervencí má vlastní verzovaný archiv; původní run odkazoval pouze na fixture replay.','',
  ].join('\n'));
});
