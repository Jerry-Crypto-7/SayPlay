import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BODY, FLAG, HEADER, ROLE, NO_INPUT, bodyBase } from '@/play/arcade/contract';
import { FAIR_START, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { verifyArcade } from '@/play/arcade/verify';
import { flapRules, flapTrack } from '@/play/arcade/pieces/flap';
import { liveCells, assemblyOfCell } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { readGameSpec } from '@/play/spec';

const make=(id:string,seed=1)=>{
 const cell=liveCells().find(cell=>cell.id===id);if(!cell)throw new Error(id);
 const spec=compileRecipe(assemblyOfCell(cell));const read=readGameSpec(spec);if(!read.ok)throw new Error(JSON.stringify(read));
 const result=arcadeWorldOf(spec,seed);if(!result.ok)throw new Error(result.issues.join(';'));
 return {...result,spec};
};
describe('T23 additional real track objectives',()=>{
 it('fills two distinct objectives and an extra action/threat for run, jump and flap',()=>{
  for(const move of ['run','jump','flap']){
   const cells=liveCells().filter(cell=>cell.recipe.move===move);
   expect(new Set(cells.map(cell=>cell.recipe.objective)).size).toBeGreaterThanOrEqual(2);
   expect(cells.some(cell=>cell.recipe.actions.length+cell.recipe.threats.length>0)).toBe(true);
  }
 });
 // run.escape may lose one seed: the runner bot's coin pace (P46B R1) costs it seed 4, publish picks a won seed.
 // Owner's decision, plans/P46B-useky-a-boss-2026-10-12.md R3 (b).
 it.each(['run.escape','jump.escape','flap.collect'])('%s wins with actual action/goal witnesses on seeds1–5',id=>{
  const lost:number[]=[];
  for(let seed=1;seed<=5;seed++){
   const made=make(id,seed),v=verifyArcade(made.world,undefined,made.roleBindings);
   expect(v.replayEqual).toBe(true);
   if(v.bot.outcome!=='won'){lost.push(seed);continue;}
   expect(v.publishEligible).toBe(true);
   const expected=id==='flap.collect'?['flap','collect']:id==='run.escape'?['run','chaser','escape']:['jump','chaser','escape'];
   for(const verb of expected)expect(v.witnesses.some(w=>w.verb===verb),`${id}/${seed}/${verb}`).toBe(true);
   if(id==='flap.collect')expect(v.witnesses.some(w=>w.verb==='collect'&&w.object?.label==='coin')).toBe(true);
  }
  expect(lost.length,`${id} lost seeds ${lost}`).toBeLessThanOrEqual(id==='run.escape'?1:0);
 },60000);
 it.each(['run.escape','jump.escape'])('%s actually loses when the pursuer catches the player',id=>{
  const made=make(id),state=instantiate(made.world),program=loadProgram(made.world,ARCADE_LIBRARY);
  const target=Array.from({length:state[HEADER.bodyCount]!},(_,i)=>i).find(i=>state[bodyBase(i)+BODY.role]===ROLE.chaser);expect(target).toBeDefined();
  const p=bodyBase(state[HEADER.player]!),b=bodyBase(target!);
  state[b+BODY.x]=state[p+BODY.x]!;state[b+BODY.y]=state[p+BODY.y]!;state[b+BODY.z]=state[p+BODY.z]!;
  // Férový start (P70A T3): v ochraně dopadení neprohraje, po ní ano.
  const late=state.slice();late[HEADER.tick]=FAIR_START.protectTicks;
  step(state,NO_INPUT,program);expect(outcomeOf(state)).toBe('running');
  step(late,NO_INPUT,program);expect(outcomeOf(late)).toBe('lost');
 });
 it('flap collect physically requires every visible gap collectible before finish',()=>{
  const made=make('flap.collect'),initial=made.world.initial.slice();
  const items=Array.from({length:initial[HEADER.bodyCount]!},(_,i)=>i).filter(i=>initial[bodyBase(i)+BODY.role]===ROLE.collectible);
  expect(items.length).toBeGreaterThan(1);
  for(const i of items)expect(made.world.kinds[initial[bodyBase(i)+BODY.kind]!]).toBe('coin');
  expect(made.world.rules.find(rule=>rule.id==='finish')?.params).toEqual({allItems:true});
  initial[bodyBase(items[0]!)+BODY.x]=50000;
  const missed=verifyArcade({...made.world,initial},undefined,made.roleBindings);
  expect(missed.bot.outcome).not.toBe('won');expect(missed.publishEligible).toBe(false);
 });
 it('does not infer escape without an actual harmful pursuer',()=>{
  const made=make('run.escape'),initial=made.world.initial.slice();
  for(let i=0;i<initial[HEADER.bodyCount]!;i++)if(initial[bodyBase(i)+BODY.role]===ROLE.chaser)initial[bodyBase(i)+BODY.flags]! &= ~FLAG.alive;
  const v=verifyArcade({...made.world,initial},undefined,made.roleBindings);
  expect(v.witnesses.some(w=>w.verb==='chaser'||w.verb==='escape')).toBe(false);
 });
 it('optional collect mode preserves default flap generation and finish rule exactly',()=>{
  for(const seed of [1,5])expect(flapTrack.generate(seed,flapTrack.params.parse({}))).toEqual(flapTrack.generate(seed,flapTrack.params.parse({collectAll:false})));
  expect(flapRules()).toEqual(flapRules(undefined,false,false,false));
  expect(flapRules().find(rule=>rule.id==='finish')?.params).toEqual({});
 });
});
