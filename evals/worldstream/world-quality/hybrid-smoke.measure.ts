import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';
import { compileWithRepair } from '@/model/worldstream-repair';
import { frozenGrammar } from '@/model/client';
import type { UpstreamRequest } from '@/model/prompt';

it('records one live hybrid creation, retaining all rejected responses', async () => {
  const folder=process.env.P20_HYBRID_RUN_DIR;
  if (!folder) throw new Error('P20_HYBRID_RUN_DIR must be a new explicit artifact directory');
  mkdirSync(folder,{recursive:true});
  const prompt='A small reading room with one glass aquarium, two seated people facing the aquarium, and a computer terminal that switches on a signal light.';
  const config=upstreamConfigFromEnv({ ...process.env,
    WORLDSMITH_MODEL_ENDPOINT:'codex-cli', WORLDSMITH_MODEL:'gpt-6-astra', WORLDSMITH_MODEL_EFFORT:'medium',
    WORLDSMITH_MODEL_PROFILE:'subscription', WORLDSMITH_MODEL_KEY:'unused-cli-transport', WORLDSMITH_CALL_CAP:'3',
    // Nominal accounting units for this bounded subscription experiment, NOT a price claim.
    WORLDSMITH_USD_PER_MTOK_IN:'1', WORLDSMITH_USD_PER_MTOK_OUT:'1' });
  if (!config) throw new Error('CLI transport configuration unavailable');
  const upstream=upstreamBranch(config);
  const records: unknown[]=[];
  const started=performance.now();
  const emit=async(request:UpstreamRequest) => {
    const at=performance.now(); const result=await upstream.generate({prompt:request.user,request});
    records.push({request,result,ms:performance.now()-at});
    writeFileSync(join(folder,'calls.json'),JSON.stringify(records,null,2));
    if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
    return result.body;
  };
  let report: unknown;
  try {
    const plan=readPlannerEmission(await emit(buildIntentRequest(prompt)),{prompt,requireSceneSpec:true});
    writeFileSync(join(folder,'planner.json'),JSON.stringify(plan,null,2));
    const intentMs=performance.now()-started;
    if (!plan.ok) report={kind:'planner-rejected',prompt,intentMs,plan};
    else {
      const grammar=frozenGrammar(); if (!grammar.ok) throw new Error(grammar.detail);
      const outcome=await compileWithRepair({plan:plan.value,grammar:grammar.value,sessionSeed:4021,emit,maxRounds:2});
      report={prompt,intentMs,totalMs:performance.now()-started,outcome,provenance:'live gpt-6-astra medium codex-cli; no browser timing'};
      if (outcome.kind==='compiled') writeFileSync(join(folder,'blueprint.json'),JSON.stringify(outcome.result.value,null,2));
    }
  } catch(error) { report={kind:'unavailable',prompt,totalMs:performance.now()-started,error:String(error)}; }
  writeFileSync(join(folder,'result.json'),JSON.stringify(report,null,2));
  // A completed experiment is not a passing generation gate. The outcome is in the artifact.
  expect(records.length).toBeGreaterThan(0);
}, 900_000);
