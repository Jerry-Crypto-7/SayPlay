import { afterAll, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, platform } from 'node:os';
const samples = vi.hoisted(() => [] as {ms:number;verdict:string}[]);
vi.mock('@/worldstream/accepted-branch', async importOriginal => {
  const actual = await importOriginal<typeof import('@/worldstream/accepted-branch')>();
  return {...actual,compareAcceptedBranch:(...args:Parameters<typeof actual.compareAcceptedBranch>) => {
    const started=performance.now(); const result=actual.compareAcceptedBranch(...args);
    samples.push({ms:performance.now()-started,verdict:result.verdict}); return result;
  }};
});
import './a4.test';
afterAll(() => {
  const dir=process.env.P20_REPLAY_RUN_DIR;
  if (!dir) throw new Error('Set a fresh P20_REPLAY_RUN_DIR');
  mkdirSync(dir,{recursive:true});
  const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
  writeFileSync(join(dir,'local-replay.json'),JSON.stringify({
    provenance:'Node fixture replay of all 10 frozen A4 oracles; no model, HTTP, browser or human timing',
    cpu:cpus()[0]?.model,os:platform(),node:process.version,samples,
    p95Ms:sorted[Math.ceil(sorted.length*0.95)-1],
  },null,2));
});
