import {describe,it,expect} from 'vitest';
import {createZoneTracker,zoneKey} from '../zones';
describe('render-only zone retention',()=>{
  it('requires sustained invisible distance and retains heroes regardless of pixel size',()=>{
    const zones=createZoneTracker(),base={id:'one',importance:2,distance:70,inFrame:false,suspended:false,now:0};
    expect(zones.decide(base)).toBe('retain');expect(zones.decide({...base,now:4.9})).toBe('retain');
    expect(zones.decide({...base,now:5})).toBe('suspend');
    expect(zones.decide({...base,importance:3,now:8})).toBe('retain');
    expect(zones.decide({...base,now:9})).toBe('retain');
    expect(zones.decide({...base,inFrame:true,now:15})).toBe('retain');
  });
  it('hysteresis prevents boundary thrash and prunes removed identities',()=>{
    const zones=createZoneTracker(),base={id:'one',importance:2,distance:70,inFrame:false,suspended:false,now:0};
    zones.decide(base);zones.prune(new Set());expect(zones.decide({...base,now:10})).toBe('retain');
    expect(zones.decide({...base,suspended:true,distance:40,now:11})).toBe('retain');
    expect(zones.decide({...base,suspended:true,distance:36,now:12})).toBe('resume');
    expect(zones.decide({...base,suspended:true,inFrame:true,now:12})).toBe('resume');
    expect(zoneKey([-1,0,48])).toBe('-1:2');
  });
});
