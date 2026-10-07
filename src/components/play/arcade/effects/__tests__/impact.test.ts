import { describe, expect, it } from 'vitest';
import { type ArcadeEffect, BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, HEADER_SIZE, ROLE, bodyBase } from '@/play/arcade/contract';
import { actualHitBodies } from '../impact';
import { createRenderFeel } from '../render-feel';
import type { EffectsSource } from '../bus';
const make=()=>{const s=new Int32Array(HEADER_SIZE+3*BODY_STRIDE);s[HEADER.bodyCount]=3;s[HEADER.counters+COUNTER.health]=3;for(let i=0;i<3;i++){const b=bodyBase(i);s[b+BODY.flags]=FLAG.alive;s[b+BODY.w]=s[b+BODY.h]=s[b+BODY.d]=200;}s[bodyBase(1)+BODY.role]=ROLE.projectile;s[bodyBase(2)+BODY.role]=ROLE.target;return s;};
const shots={rules:[{id:'shot_hit',params:{}}]};
describe('T29 actual impact evidence',()=>{
 it('ignores grace-blocked damage and score/pickup despawns',()=>{
  const before=make(),after=before.slice();
  expect([...actualHitBodies([{kind:'damage',amount:1}],before,after)]).toEqual([]);
  after[bodyBase(2)+BODY.flags]=0;
  expect([...actualHitBodies([{kind:'score',amount:1},{kind:'despawn',body:2}],before,after,shots)]).toEqual([]);
  after[HEADER.counters+COUNTER.health]=2;
  expect([...actualHitBodies([{kind:'damage',amount:1}],before,after)]).toEqual([0]);
 });
 it('recognizes no-lives contact loss but never a generic timer loss',()=>{
  const before=make(),after=before.slice();after[HEADER.runState]=2;before[bodyBase(2)+BODY.role]=after[bodyBase(2)+BODY.role]=ROLE.obstacle;
  expect([...actualHitBodies([{kind:'lose'}],before,after,{rules:[{id:'time_limit',params:{}}]})]).toEqual([]);
  expect([...actualHitBodies([{kind:'lose'}],before,after,{rules:[{id:'hit',params:{role:'obstacle',effect:'lose'}}]})]).toEqual([0]);
  after[bodyBase(2)+BODY.z]=5000;expect([...actualHitBodies([{kind:'lose'}],before,after,{rules:[{id:'hit',params:{role:'obstacle',effect:'lose'}}]})]).toEqual([]);
 });
 it('requires a real swept projectile contact and active shot rule',()=>{
  const before=make(),after=before.slice(),p=bodyBase(1),t=bodyBase(2);
  before[p+BODY.z]=800;after[p+BODY.z]=1200;after[p+BODY.vz]=400;before[t+BODY.z]=after[t+BODY.z]=1000;
  after[p+BODY.flags]=after[t+BODY.flags]=0;
  const effects:ArcadeEffect[]=[{kind:'score',amount:1},{kind:'despawn',body:2}];
  expect([...actualHitBodies(effects,before,after,shots)]).toEqual([2]);
  expect([...actualHitBodies(effects,before,after,{rules:[]})]).toEqual([]);
  after[t+BODY.x]=5000;expect([...actualHitBodies(effects,before,after,shots)]).toEqual([]);
 });
 it('holds only draw time while ticks continue; restart and disposal clear the subscription',()=>{
  let before=make(),after=before.slice(),now=0;
  const events=new Set<(e:readonly ArcadeEffect[],tick:number)=>void>(),subscriptions=new Set<()=>void>();
  const source:EffectsSource={state:()=>after,prev:()=>before,humanRun:()=>true,onEvents:f=>{events.add(f);return()=>events.delete(f);},subscribe:f=>{subscriptions.add(f);return()=>subscriptions.delete(f);}};
  const feel=createRenderFeel(source,()=>now);
  after[HEADER.tick]=1;after[HEADER.counters+COUNTER.health]=2;
  const state=after.slice();events.forEach(f=>f([{kind:'damage',amount:1}],0));subscriptions.forEach(f=>f());
  expect(feel.held()).toBe(true);expect(after).toEqual(state);
  before=after.slice();after[HEADER.tick]=3;subscriptions.forEach(f=>f());now=59;
  expect(feel.held()).toBe(true);expect(after[HEADER.tick]).toBe(3);
  now=60;expect(feel.held()).toBe(false);
  after[HEADER.tick]=0;subscriptions.forEach(f=>f());expect(feel.flash()).toBe(0);
  feel.dispose();expect(events.size).toBe(0);expect(subscriptions.size).toBe(0);
 });
});
