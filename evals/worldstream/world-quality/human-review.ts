import {z} from 'zod';
import protocol from './protocol.json';
import development from './development.json';
import holdout from './holdout.json';

const id=z.string().trim().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/);
const source=z.object({ref:id,sha256:hash}).strict();
const judgment=z.enum(['yes','no','unknown']);
const roster=z.array(z.object({participant:id,independent:z.literal(true),kind:z.literal('human')}).strict());
const rating=z.number().int().min(1).max(5).nullable();
const milestone=z.number().finite().nonnegative().nullable();
export const humanSubmissionSchema=z.object({
  version:z.literal('p20-human-v1'),runId:id,datasetHash:hash,buildHash:hash,
  raters:z.object({recognition:roster,quality:roster,a4:roster}).strict(),
  worlds:z.array(z.object({worldId:id,status:z.enum(['available','rejected','missing']),source:source.nullable()}).strict()),
  recognition:z.array(z.object({worldId:id,participant:id,source,blindDescription:z.string().trim().min(1),place:judgment,requirements:z.record(z.string(),judgment)}).strict()),
  pairs:z.array(z.object({pairId:id,worldId:id,oldSource:source,newSource:source,oldBlueprintHash:hash,newBlueprintHash:hash,oldCameraHash:hash,newCameraHash:hash,oldViewport:id,newViewport:id,durationSeconds:z.literal(20),randomizationEvidence:source}).strict()),
  quality:z.array(z.object({participant:id,source,overall:rating,dissent:z.string()}).strict()),
  preferences:z.array(z.object({participant:id,pairId:id,source,order:z.enum(['old-new','new-old']),preference:z.enum(['old','new','tie','unknown']),reason:z.string().trim().min(1)}).strict()),
  a4:z.array(z.object({participant:id,source,ownPrompt:z.string().trim().min(1),generationMs:milestone,assisted:z.boolean().nullable(),completed:z.boolean().nullable(),understoodDifference:z.boolean().nullable(),verbatimAnswer:z.string(),device:id,browser:id,
    milestonesSeconds:z.object({firstAction:milestone,timeControl:milestone,rewind:milestone,proposal:milestone,preview:milestone,confirmation:milestone,difference:milestone}).strict()}).strict()),
}).strict();
export type HumanSubmissions=z.infer<typeof humanSubmissionSchema>;
type Gate='PASS'|'FAIL'|'PENDING'|'INVALID';
const cases=[...development.map(c=>({...c,split:'development' as const})),...holdout.map(c=>({...c,split:'holdout' as const}))];
/** Pure aggregation. Evidence references attest provenance, not authenticity: an
 * operator must verify archived human records; no model judgments are accepted. */
export function aggregateHumanReview(input:unknown){
  const parsed=humanSubmissionSchema.safeParse(input);
  if(!parsed.success)return {status:'INVALID' as Gate,issues:parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`),gates:{'G-V':'INVALID','G-W':'INVALID','A4-human':'INVALID'}};
  const x=parsed.data,issues:string[]=[],seenSources=new Set<string>(),seenContent=new Set<string>();
  const unique=(values:string[],label:string)=>{if(new Set(values).size!==values.length)issues.push(`Duplicate ${label}`);};
  const evidence=(s:z.infer<typeof source>)=>{if(seenSources.has(s.ref)||seenContent.has(s.sha256))issues.push(`Reused submission source: ${s.ref}`);seenSources.add(s.ref);seenContent.add(s.sha256);};
  for(const [name,people]of Object.entries(x.raters))unique(people.map(p=>p.participant),`${name} participant`);
  const known=(group:keyof typeof x.raters,participant:string)=>{if(!x.raters[group].some(p=>p.participant===participant))issues.push(`Unknown ${group} participant: ${participant}`);};
  const expected=new Map(cases.map(c=>[c.id,c]));unique(x.worlds.map(w=>w.worldId),'world');
  for(const w of x.worlds)if(!expected.has(w.worldId))issues.push(`Unknown world: ${w.worldId}`);
  unique(x.worlds.flatMap(w=>w.source?[w.source.ref]:[]),'world source');
  unique(x.worlds.flatMap(w=>w.source?[w.source.sha256]:[]),'world source content');
  for(const w of x.worlds)if((w.status==='available')!==!!w.source)issues.push(`World source/status mismatch: ${w.worldId}`);
  unique(x.recognition.map(r=>`${r.worldId}\0${r.participant}`),'recognition vote');
  for(const r of x.recognition){known('recognition',r.participant);evidence(r.source);const c=expected.get(r.worldId);
    if(!c||x.worlds.find(w=>w.worldId===r.worldId)?.status!=='available')issues.push(`Unreviewable world: ${r.worldId}`);
    else if(JSON.stringify(Object.keys(r.requirements).sort())!==JSON.stringify([...c.requirements].sort()))issues.push(`Requirement coverage mismatch: ${r.worldId}`);
  }
  unique(x.pairs.map(p=>p.pairId),'pair');unique(x.pairs.map(p=>p.worldId),'paired world');
  unique(x.pairs.flatMap(p=>[p.oldSource.ref,p.newSource.ref]),'pair source');
  unique(x.pairs.flatMap(p=>[p.oldSource.sha256,p.newSource.sha256]),'pair source content');
  for(const p of x.pairs){if(!expected.has(p.worldId)||x.worlds.find(w=>w.worldId===p.worldId)?.status!=='available')issues.push(`Unknown or unavailable paired world: ${p.worldId}`);
    if(p.oldBlueprintHash!==p.newBlueprintHash||p.oldCameraHash!==p.newCameraHash||p.oldViewport!==p.newViewport||p.oldSource.ref===p.newSource.ref)issues.push(`Unmatched pair: ${p.pairId}`);}
  unique(x.quality.map(r=>r.participant),'quality vote');for(const r of x.quality){known('quality',r.participant);evidence(r.source);}
  unique(x.preferences.map(r=>`${r.pairId}\0${r.participant}`),'pair vote');for(const r of x.preferences){known('quality',r.participant);evidence(r.source);if(!x.pairs.some(p=>p.pairId===r.pairId))issues.push(`Unknown pair: ${r.pairId}`);}
  unique(x.a4.map(r=>r.participant),'A4 participant');for(const r of x.a4){known('a4',r.participant);evidence(r.source);const times=Object.values(r.milestonesSeconds).filter((n):n is number=>n!==null);if(times.some((n,i)=>i>0&&n<times[i-1]))issues.push(`Non-monotonic A4 milestones: ${r.participant}`);}
  if(x.raters.recognition.length>3||x.raters.quality.length>5||x.raters.a4.length>5)issues.push('Roster exceeds frozen denominator');
  if(issues.length)return {status:'INVALID' as Gate,issues,gates:{'G-V':'INVALID','G-W':'INVALID','A4-human':'INVALID'}};
  const decisions=cases.map(c=>{const w=x.worlds.find(w=>w.worldId===c.id),votes=x.recognition.filter(r=>r.worldId===c.id);
    let status:Gate='PENDING';if(w?.status==='rejected')status='FAIL';
    else if(w?.status==='available'&&x.raters.recognition.length===3&&votes.length===3){const fields=votes.map(r=>[r.place,...c.requirements.map(k=>r.requirements[k])]);
      if(!fields.flat().includes('unknown'))status=fields[0].every((_,i)=>fields.filter(v=>v[i]==='yes').length>=2)?'PASS':'FAIL';}
    return {worldId:c.id,split:c.split,status};});
  const split=(name:'development'|'holdout',threshold:number)=>{const rows=decisions.filter(d=>d.split===name),passed=rows.filter(d=>d.status==='PASS').length,pending=rows.filter(d=>d.status==='PENDING').length;return {passed,pending,total:rows.length,threshold,status:(passed+pending<threshold?'FAIL':pending?'PENDING':passed>=threshold?'PASS':'FAIL') as Gate};};
  const dev=split('development',protocol.gates['G-V'].developmentRecognized),held=split('holdout',protocol.gates['G-V'].holdoutRecognized);
  const gv:Gate=dev.status==='FAIL'||held.status==='FAIL'?'FAIL':dev.status==='PASS'&&held.status==='PASS'?'PASS':'PENDING';
  const qualityComplete=x.raters.quality.length===5&&x.quality.length===5&&x.quality.every(r=>r.overall!==null)&&x.pairs.length>0&&x.preferences.length===5*x.pairs.length&&x.preferences.every(r=>r.preference!=='unknown');
  const high=x.quality.filter(r=>r.overall!==null&&r.overall>=4).length,newVotes=x.preferences.filter(r=>r.preference==='new').length,pairDenominator=5*x.pairs.length;
  const gw:Gate=!qualityComplete?'PENDING':high>=protocol.gates['G-W'].ratingsAtLeastFourOfFive&&newVotes/pairDenominator>=protocol.gates['G-W'].pairedPreference?'PASS':'FAIL';
  const a4=x.a4.map(r=>({participant:r.participant,status:(r.assisted===null||r.completed===null||r.understoodDifference===null||r.generationMs===null||!r.verbatimAnswer.trim()||Object.values(r.milestonesSeconds).includes(null)?'PENDING':!r.assisted&&r.completed&&r.understoodDifference&&r.milestonesSeconds.difference!<=180?'PASS':'FAIL') as Gate}));
  const successes=a4.filter(r=>r.status==='PASS').length;
  const a4Status:Gate=x.raters.a4.length!==5||a4.length!==5||a4.some(r=>r.status==='PENDING')?'PENDING':successes>=3?'PASS':'FAIL';
  return {status:'VALID' as const,issues,gates:{'G-V':gv,'G-W':gw,'A4-human':a4Status},recognition:{development:dev,holdout:held,worlds:decisions},quality:{highRatings:high,requiredHighRatings:4,newVotes,pairDenominator,requiredPreference:.8},a4:{successful:successes,total:5,required:3,limitSeconds:180,participants:a4},limits:['Human records and identity independence require operator verification.','Evidence hashes are supplied references, not filesystem/content verification.','This does not replace model, browser, performance or public-host gates.']};
}
