import { expect, it } from 'vitest';
import { readGameSpec } from '@/play/spec';
import arena from '../__fixtures__/arena.json';
import { arcadeWorldOf } from '../compile';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '../contract';
import { instantiate } from '../kernel';
import { WitnessRecorder, type ActionWitness } from '../witness';

it.each([false, true])('movement history survives return to start but resets on death: %s', (dies) => {
  const read = readGameSpec({...arena,addons:['chaser'],roles:[...arena.roles,{id:'chaser',kind:'chaser',label:'dog'}]});
  if(!read.ok)throw new Error(read.issues.join(';'));
  const built=arcadeWorldOf(read.value,1);if(!built.ok)throw new Error(built.issues.join(';'));
  const threat=built.roleBindings.find(b=>b.roleKind==='chaser')!;
  const hero=built.roleBindings.find(b=>b.player)!;
  expect(threat).toBeDefined();
  const state=instantiate(built.world);
  const recorder=new WitnessRecorder(built.world,built.roleBindings,'winner','movement-history');
  const base=bodyBase(threat.body);
  state[base+BODY.flags]!|=FLAG.alive;
  let before=state.slice();
  state[base+BODY.x]!+=UNIT;
  recorder.afterTick(before,state,0);
  before=state.slice();state[base+BODY.x]!-=UNIT;
  recorder.afterTick(before,state,1);
  if(dies){
    before=state.slice();state[base+BODY.flags]!&=~FLAG.alive;recorder.afterTick(before,state,2);
    before=state.slice();state[base+BODY.flags]!|=FLAG.alive;recorder.afterTick(before,state,3);
  }
  const probe:ActionWitness={actor:threat,verb:'chaser',object:hero,tick:1,evidence:'harmful-contact',run:'probe',runId:'probe:dog'};
  const found=recorder.escaped([probe],state,state[HEADER.tick]!);
  expect(found.some(w=>w.verb==='escape'&&w.object?.roleId===threat.roleId)).toBe(!dies);
  expect(found.some(w=>w.verb==='survive'&&w.object?.roleId===threat.roleId)).toBe(true);
});

it.each([false,true])('indexed spawned bindings retain ambiguity and direct precedence: %s',(ambiguous)=>{
  const read=readGameSpec({...arena,addons:['chaser'],roles:[...arena.roles,{id:'chaser',kind:'chaser',label:'dog'}]});
  if(!read.ok)throw new Error(read.issues.join(';'));
  const built=arcadeWorldOf(read.value,1);if(!built.ok)throw new Error(built.issues.join(';'));
  const hero=built.roleBindings.find(b=>b.player)!;
  const threat=built.roleBindings.find(b=>b.roleKind==='chaser')!;
  const initial=[...built.world.initial];
  const hb=bodyBase(hero.body),tb=bodyBase(threat.body);
  if(ambiguous)for(const slot of [BODY.role,BODY.kind])initial[tb+slot]=initial[hb+slot]!;
  const world={...built.world,initial};
  const state=instantiate(world);
  const body=Array.from({length:state[HEADER.bodyCount]!},(_,i)=>i).find(i=>i!==hero.body&&i!==threat.body)!;
  const base=bodyBase(body);
  const recorder=new WitnessRecorder(world,[hero,threat],'winner','binding-index');
  state[HEADER.player]=body;
  state[base+BODY.flags]!|=FLAG.alive;
  for(const slot of [BODY.role,BODY.kind])state[base+slot]=initial[hb+slot]!;
  recorder.afterTick(state.slice(),state,0);
  let before=state.slice();state[base+BODY.x]!+=UNIT;recorder.afterTick(before,state,1);
  expect(recorder.finish('won').some(w=>w.verb==='roam'&&w.actor.body===body)).toBe(!ambiguous);
  if(!ambiguous){
    for(const slot of [BODY.role,BODY.kind])state[base+slot]=initial[tb+slot]!;
    recorder.afterTick(state.slice(),state,2);
    before=state.slice();state[base+BODY.x]!+=UNIT;recorder.afterTick(before,state,3);
    expect(recorder.finish('won').some(w=>w.verb==='roam'&&w.actor.body===body&&w.actor.roleId===threat.roleId)).toBe(true);
  }
  // A direct original binding wins even when matching templates are ambiguous.
  const direct=new WitnessRecorder(world,[hero,threat],'winner','direct-binding');
  state[HEADER.player]=hero.body;
  before=state.slice();state[hb+BODY.x]!+=UNIT;direct.afterTick(before,state,4);
  expect(direct.finish('won').some(w=>w.verb==='roam'&&w.actor.body===hero.body&&w.actor.roleId===hero.roleId)).toBe(true);
});
