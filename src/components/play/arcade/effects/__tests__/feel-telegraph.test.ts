import { describe, expect, it } from 'vitest';
import { BODY, FLAG, HEADER, HEADER_SIZE, BODY_STRIDE, ROLE, bodyBase } from '@/play/arcade/contract';
const world={rules:[{id:'hit',params:{role:'enemy',effect:'damage'}}]};
import { createImpactClock, skidStrength, threatTelegraphs } from '../feel';

describe('T29 visual-only feel', () => {
  it('only real bus hits freeze and flash; score, death and spawn do not', () => {
    const clock = createImpactClock();
    clock.observe([{kind:'spawn'}, {kind:'pickup'}, {kind:'death'}], 0);
    expect(clock.held(0)).toBe(false); expect(clock.flash(0)).toBe(0);
    clock.observe([{kind:'hit'}], 100);
    expect(clock.held(159)).toBe(true); expect(clock.held(160)).toBe(false);
    expect(clock.flash(100)).toBe(1); expect(clock.flash(220)).toBe(0);
    clock.reset(); expect(clock.held(101)).toBe(false);
  });
  it('slip needs actual lateral motion, speed and ground contact', () => {
    expect(skidStrength(0,300,true)).toBe(0);
    expect(skidStrength(120,0,true)).toBe(0);
    expect(skidStrength(120,300,false)).toBe(0);
    expect(skidStrength(120,300,true)).toBeGreaterThan(0.9);
  });
  it('warns approaching XYZ threats, ignores receding/dead/height-separated bodies without mutating state', () => {
    const state = new Int32Array(HEADER_SIZE+2*BODY_STRIDE);
    state[HEADER.bodyCount]=2; state[HEADER.player]=0;
    for(let i=0;i<2;i++){ const b=bodyBase(i); state[b+BODY.flags]=FLAG.alive; state[b+BODY.w]=1000;state[b+BODY.h]=1000;state[b+BODY.d]=1000; }
    const b=bodyBase(1); state[b+BODY.role]=ROLE.enemy; state[b+BODY.z]=6000; state[b+BODY.vz]=-200;
    expect(threatTelegraphs(state,{rules:[]})).toHaveLength(0);
    const before=state.slice(); expect(threatTelegraphs(state,world)).toHaveLength(1); expect(state).toEqual(before);
    state[b+BODY.vz]=200; expect(threatTelegraphs(state,world)).toHaveLength(0);
    state[b+BODY.vz]=-200; state[b+BODY.y]=9000; expect(threatTelegraphs(state,world)).toHaveLength(0);
    state[b+BODY.y]=0; state[b+BODY.flags]=0; expect(threatTelegraphs(state,world)).toHaveLength(0);
  });
});
