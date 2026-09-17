import {describe,it,expect} from 'vitest';
import {reviewScene} from './review';
import {compileSemanticLayoutFixture} from '../../../src/app/dev/semantic-layout/fixture';

describe('hybrid evidence review',()=>{
  it('keeps fixture provenance, browser evidence and human judgment independent',()=>{
    const {value:blueprint}=compileSemanticLayoutFixture();
    const planned=blueprint.objects;
    const input={blueprint,planned,provenance:{kind:'fixture' as const,artifact:'fixture.json'}};
    const offline=reviewScene(input);
    expect(offline.metrics.nounCoverage).toBeNull();
    expect(offline.instances.find(item=>item.source==='asset')).toMatchObject({catalogResolved:true,loaded:'unobserved',sampledVisible:null,recognizable:'unreviewed'});
    const stableId=planned.find(item=>item.source.kind==='asset')!.stableId;
    const browser={artifact:'browser.json',observations:[{stableId,built:true,loaded:true,inFrame:true,screenPixels:100,unoccludedSamples:3,samples:5}]};
    expect(reviewScene({...input,browser}).instances.find(item=>item.stableId===stableId)).toMatchObject({loaded:true,sampledVisible:true,recognizable:'unreviewed'});
    const human={reviewer:'reviewer-1',artifact:'rating.json',recognition:{[stableId]:false}};
    const reviewed=reviewScene({...input,browser,human});
    expect(reviewed.instances.find(item=>item.stableId===stableId)).toMatchObject({sampledVisible:true,recognizable:false});
    expect(reviewed.provenance.kind).toBe('fixture');expect(reviewed.evidence.human?.artifact).toBe('rating.json');
  });
});
