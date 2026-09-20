import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {aggregateHumanReview,type HumanSubmissions} from './human-review';
import dev from './development.json';import hold from './holdout.json';
import template from './human-review.template.json';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const source=(ref:string)=>({ref,sha256:hash(ref)});
const roster=(count:number)=>Array.from({length:count},(_,i)=>({participant:`fixture-person-${i}`,independent:true as const,kind:'human' as const}));
function fixture():HumanSubmissions{
 const worlds=[...dev,...hold];const raters={recognition:roster(3),quality:roster(5),a4:roster(5)};
 return {version:'p20-human-v1',runId:'SYNTHETIC-UNIT-FIXTURE-NOT-HUMAN-EVIDENCE',datasetHash:hash('fixture-dataset'),buildHash:hash('fixture-build'),raters,
 worlds:worlds.map(w=>({worldId:w.id,status:'available',source:source('world-'+w.id)})),
 recognition:worlds.flatMap(w=>raters.recognition.map(p=>({worldId:w.id,participant:p.participant,source:source(`recognition-${w.id}-${p.participant}`),blindDescription:'Synthetic unit-test answer',place:'yes',requirements:Object.fromEntries(w.requirements.map(r=>[r,'yes']))}))),
 pairs:[{pairId:'fixture-pair',worldId:dev[0].id,oldSource:source('old'),newSource:source('new'),oldBlueprintHash:hash('world'),newBlueprintHash:hash('world'),oldCameraHash:hash('camera'),newCameraHash:hash('camera'),oldViewport:'1920x1080',newViewport:'1920x1080',durationSeconds:20,randomizationEvidence:source('fixture-random-order')}],
 quality:raters.quality.map(p=>({participant:p.participant,source:source('quality-'+p.participant),overall:4,dissent:''})),
 preferences:raters.quality.map((p,i)=>({participant:p.participant,pairId:'fixture-pair',source:source('preference-'+p.participant),order:i%2?'new-old':'old-new',preference:'new',reason:'Synthetic unit-test answer'})),
 a4:raters.a4.map(p=>({participant:p.participant,source:source('a4-'+p.participant),ownPrompt:'Synthetic unit-test own prompt',generationMs:1000,assisted:false,completed:true,understoodDifference:true,verbatimAnswer:'Synthetic unit-test answer',device:'fixture',browser:'fixture',milestonesSeconds:{firstAction:1,timeControl:2,rewind:3,proposal:4,preview:5,confirmation:6,difference:180}}))};
}
describe('human acceptance aggregation (synthetic unit fixtures, never study evidence)',()=>{
 it('never passes the blank template or a missing study',()=>{expect(aggregateHumanReview(template).status).toBe('INVALID');const x=fixture();x.worlds=[];x.recognition=[];x.pairs=[];x.preferences=[];x.quality=[];x.a4=[];expect(aggregateHumanReview(x).gates).toEqual({'G-V':'PENDING','G-W':'PENDING','A4-human':'PENDING'});});
 it('uses three-rater majority per requirement and keeps all 30 cases',()=>{const x=fixture();for(const r of x.recognition)if(r.participant==='fixture-person-2'){r.place='no';for(const k in r.requirements)r.requirements[k]='no';}const r=aggregateHumanReview(x);expect(r.gates['G-V']).toBe('PASS');if(r.status==='VALID'){expect(r.recognition.development.total).toBe(10);expect(r.recognition.holdout.total).toBe(20);}});
 it('does not drop rejected generations or pass an unknown required judgment',()=>{const x=fixture();x.pairs=[];x.preferences=[];for(const id of dev.slice(0,3).map(w=>w.id)){x.worlds.find(w=>w.worldId===id)!.status='rejected';x.worlds.find(w=>w.worldId===id)!.source=null;x.recognition=x.recognition.filter(r=>r.worldId!==id);}expect(aggregateHumanReview(x).gates['G-V']).toBe('FAIL');const y=fixture();y.recognition[0].place='unknown';expect(aggregateHumanReview(y).gates['G-V']).toBe('PENDING');});
 it('rejects duplicated people, repeated votes/source content and mismatched paired evidence',()=>{for(const mutate of [(x:HumanSubmissions)=>x.raters.recognition.push(x.raters.recognition[0]),(x:HumanSubmissions)=>x.recognition.push(x.recognition[0]),(x:HumanSubmissions)=>{x.recognition[1].source.sha256=x.recognition[0].source.sha256;},(x:HumanSubmissions)=>{x.pairs[0].newCameraHash=hash('different');}]){const x=fixture();mutate(x);expect(aggregateHumanReview(x).status).toBe('INVALID');}});
 it('requires 4/5 quality and 80% preferences, retaining ties in denominator',()=>{const x=fixture();x.quality[0].overall=3;x.preferences[0].preference='tie';expect(aggregateHumanReview(x).gates['G-W']).toBe('PASS');x.preferences[1].preference='old';expect(aggregateHumanReview(x).gates['G-W']).toBe('FAIL');x.preferences[1].preference='unknown';expect(aggregateHumanReview(x).gates['G-W']).toBe('PENDING');});
 it('requires 3/5 unaided completions within 180s and records missing timing as pending',()=>{const x=fixture();x.a4[0].assisted=true;x.a4[1].milestonesSeconds.difference=181;expect(aggregateHumanReview(x).gates['A4-human']).toBe('PASS');x.a4[2].understoodDifference=false;expect(aggregateHumanReview(x).gates['A4-human']).toBe('FAIL');x.a4[2].generationMs=null;expect(aggregateHumanReview(x).gates['A4-human']).toBe('PENDING');});
});
