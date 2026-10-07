import { describe, expect, it } from 'vitest';
import { BODY, BUTTON, HEADER_SIZE, BODY_STRIDE, bodyBase } from '../contract';
import { steerControl, steerTrack, steerControlRef, STEER } from '../pieces/steer';

const stateOf = () => { const s=new Int32Array(HEADER_SIZE+BODY_STRIDE); s[bodyBase(0)+BODY.vx]=120; s[bodyBase(0)+BODY.vz]=300; return s; };
describe('bounded steer grip', () => {
  it.each([false,true])('omitted params exactly preserve legacy motion (drift=%s)', drift => {
    const a=stateOf(), b=a.slice();
    const old=steerControl.params.parse({drift});
    const explicit=steerControl.params.parse({drift,grip:drift?4:10,brakeDrift:drift?4:10});
    expect(Object.hasOwn(old,'grip')).toBe(false);
    for(let tick=0;tick<90;tick++) {
      const input={buttons:tick%3===0?BUTTON.DOWN:0,axis:tick%5===0?700:0};
      steerControl.step(a,0,input,old); steerControl.step(b,0,input,explicit);
      expect(a).toEqual(b);
    }
  });
  it('brake drift changes lateral stopping distance only while braking', () => {
    const distance=(brakeDrift:number,buttons:number) => {
      const s=stateOf();let x=0;const params=steerControl.params.parse({grip:10,brakeDrift});
      for(let i=0;i<20;i++){steerControl.step(s,0,{buttons,axis:0},params);x+=s[bodyBase(0)+BODY.vx]!;}
      return x;
    };
    expect(distance(4,BUTTON.DOWN)).toBeGreaterThan(distance(20,BUTTON.DOWN));
    expect(distance(4,0)).toBe(distance(20,0));
  });
  it('bounds coefficients and carries explicit settings through compilation refs', () => {
    for(const bad of [{grip:3},{grip:21},{brakeDrift:0},{brakeDrift:4.5}]) expect(steerControl.params.safeParse(bad).success).toBe(false);
    const params=steerTrack.params.parse({grip:8,brakeDrift:4});const level=steerTrack.generate(1,params);
    expect(steerControlRef(level,params).params).toMatchObject({grip:8,brakeDrift:4});
    expect(steerControlRef(level,{topSpeed:STEER.topSpeed,drift:false}).params).not.toHaveProperty('grip');
  });
});
