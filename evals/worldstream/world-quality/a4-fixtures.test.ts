import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {a4Specs,a4Fixture,runA4Intervention} from './a4-fixtures';
describe('live A4 harness local substrate and commit oracles (no model)',()=>{
  it('grounds the lever as the input/selected source and keeps the gate as the affected target',()=>{
    const fixture=a4Fixture(a4Specs().find(spec=>spec.id==='a05')!);
    expect(fixture.targetId).toBe('sensorA');expect(fixture.inputs[0].target).toBe('sensorA');
    expect(fixture.blueprint.objects.find(o=>o.stableId==='sensorA')!.label).toBe('Lever');
    expect((fixture.blueprint.world.sim.rules as Record<string,unknown>).rule).toMatchObject({event:{target:'sensorA'},actions:[{target:'case'}]});
  });
  it.each(['a05','a08','a10'])('preserves the archived %s raw-emission rejection under the unchanged comparison validator',async id=>{
    const root='plans/P20/a4-live-20260917-1750';
    const archived=JSON.parse(readFileSync(`${root}/fixtures/${id}.json`,'utf8'));
    const raw=JSON.parse(readFileSync(`${root}/raw/${id}.json`,'utf8'));
    const fixture={...archived,oracle:a4Fixture(a4Specs().find(spec=>spec.id===id)!).oracle};
    const result=await runA4Intervention(fixture,async()=>raw.response.body);
    expect(result).toMatchObject({status:'failed',stage:'comparison',unchanged:true});
    expect(result.comparisons?.every(c=>c.failure?.reason==='UNSUPPORTED_CHANGE')).toBe(true);
  });
  it.each(a4Specs())('$id uses the unchanged frozen prompt and verifies the real commit/replay chain',async spec=>{
    const fixture=a4Fixture(spec);let calls=0;
    const result=await runA4Intervention(fixture,async request=>{
      calls++;expect(request.user).toContain(spec.changePrompt);
      expect(request.system).toContain('either its condition OR ONE existing action');
      expect(request.system).toContain('action count/order');
      expect(request.system).toContain('Do not change entities, sockets, initial state');
      expect(request.system).toContain('A shape-only edit remains supported');
      expect(request.user).not.toContain('Local expected patch');
      const {stableId,...answer}=fixture.oracle;expect(stableId).toBe(fixture.targetId);return answer;
    });
    expect(calls).toBe(1);expect(result.status,JSON.stringify(result)).toBe('passed');
    expect(fixture.inputs.every(i=>i.actionId!=='finishFixture')).toBe(true);
    if(spec.kind==='timer')expect(fixture.observations.map(o=>o.tick)).toEqual([80,400]);
  });
  it('records a rejected emission without retrying or changing the substrate',async()=>{
    const fixture=a4Fixture(a4Specs()[0]);let calls=0;
    const result=await runA4Intervention(fixture,async()=>{calls++;return {bad:'answer'};});
    expect(calls).toBe(1);expect(result).toMatchObject({status:'rejected',stage:'plan'});
  });
});
