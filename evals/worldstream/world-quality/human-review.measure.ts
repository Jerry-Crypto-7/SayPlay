/** Explicit opt-in offline study ingestion. No model/provider/network imports. */
import {it,expect} from 'vitest';
import {runHumanReview} from './human-review-runner';

it('archives and aggregates explicitly supplied human review records offline',()=>{
  const input=process.env.P20_HUMAN_INPUT,output=process.env.P20_HUMAN_OUTPUT;
  if(!input||!output)throw new Error('Set P20_HUMAN_INPUT to study JSON and P20_HUMAN_OUTPUT to a NEW directory');
  const result=runHumanReview(input,output);
  expect(['INVALID','PENDING','FAIL','PASS']).toContain(result.status);
  process.stdout.write(`Human review report: ${result.status}; G-V=${result.aggregate.gates['G-V']}; G-W=${result.aggregate.gates['G-W']}; A4=${result.aggregate.gates['A4-human']}. Runner completion is not study acceptance.\n`);
},30_000);
