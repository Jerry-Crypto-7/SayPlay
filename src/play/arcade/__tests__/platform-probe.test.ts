import { essentialTriples } from '@/play/intent/contract';
import { extractIntent } from '@/play/intent/extract';
import { expect, it } from 'vitest';
import { canonicalHash } from '@/ir/worlddoc';
import { compileGenre } from '@/play/genre';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIBRARY } from '../library';
import { COUNTER, HEADER, NO_INPUT } from '../contract';
import { instantiate, loadProgram, replay, step } from '../kernel';
import { runBot, verifyArcade } from '../verify';
import { matchesWitness } from '../witness';

function make(seed: number) {
 const spec=compileGenre({genre:'platformer',mode:'default',hero:'penguin',cast:[{label:'iceberg',does:'avoid'}],setting:'frozen iceberg field',palette:'snow'});
 const made=arcadeWorldOf(spec,seed); if(!made.ok)throw Error(made.issues.join('; '));return made;
}
it.each(Array.from({length:20},(_,i)=>i+1))('seed %i probes actual platform hazard contact and replays ordinary inputs',seed=>{
 const made=make(seed), original=canonicalHash(made.world);
 const target=made.roleBindings.find(binding=>binding.roleId==='spikes')!;
 expect(target).toBeDefined();
 const winner=runBot(made.world,undefined,{roleBindings:made.roleBindings});
 expect(winner.outcome).toBe('won');
 expect(winner.witnesses.some(w=>w.verb==='hazard')).toBe(false);
 const probe=runBot(made.world,undefined,{roleBindings:made.roleBindings,probeBody:target.body});
 const harm=probe.witnesses.find(w=>w.verb==='hazard' && w.actor.roleId==='spikes');
 expect(harm).toMatchObject({run:'probe',evidence:'harmful-contact',actor:{label:'iceberg'},object:{label:'penguin'}});
 expect(matchesWitness({actor:'iceberg',verb:'hazard',object:'penguin'},harm!)).toBe(true);
 expect(matchesWitness({actor:'bear',verb:'hazard',object:'penguin'},harm!)).toBe(false);
 const obstacle=probe.witnesses.find(w=>w.verb==='obstacle' && w.actor.roleId==='spikes');
 expect(obstacle).toBeDefined();
 expect(matchesWitness({actor:'iceberg',verb:'obstacle',object:'penguin'},obstacle!)).toBe(true);
 expect(matchesWitness({actor:'bear',verb:'obstacle',object:'penguin'},obstacle!)).toBe(false);
 const state=instantiate(made.world), program=loadProgram(made.world,ARCADE_LIBRARY);let next=0;
 for(let tick=0;tick<=harm!.tick;tick++)step(state,probe.inputs[next]?.tick===tick?probe.inputs[next++]!:NO_INPUT,program);
 expect(state[HEADER.counters+COUNTER.health]!).toBeLessThan(made.world.initial[HEADER.counters+COUNTER.health]!);
 expect(replay(made.world,probe.inputs,ARCADE_LIBRARY).hash).toBe(probe.hash);
 expect(canonicalHash(made.world)).toBe(original);
});
it('a hazard label and approach produce no witness when the damaging rule is absent',()=>{
 const made=make(1), target=made.roleBindings.find(binding=>binding.roleId==='spikes')!;
 const harmless={...made.world,rules:made.world.rules.filter(ref=>!(ref.id==='hit' && ref.params.role==='hazard'))};
 const probe=runBot(harmless,undefined,{roleBindings:made.roleBindings,probeBody:target.body});
 expect(probe.witnesses.some(w=>w.actor.roleId==='spikes' && ['hazard','obstacle'].includes(w.verb))).toBe(false);
});
it('the production verifier includes independently probed iceberg harm',()=>{
 const made=make(1), verdict=verifyArcade(made.world,undefined,made.roleBindings);
 expect(verdict.publishEligible).toBe(true);
 const wanted=essentialTriples(extractIntent('a penguin jumps over icebergs'));
 expect(wanted.filter(triple=>!verdict.witnesses.some(w=>matchesWitness(triple,w)))).toEqual([]);
 expect(verdict.witnesses.some(w=>w.verb==='hazard' && w.actor.label==='iceberg' && w.run==='probe')).toBe(true);
 expect(verdict.witnesses.some(w=>matchesWitness({actor:'iceberg',verb:'obstacle',object:'penguin'},w))).toBe(true);
});

it('renaming the physical hazard changes the proven actor, not the geometry',()=>{
 const made=make(2),target=made.roleBindings.find(binding=>binding.roleId==='spikes')!;
 const renamed=made.roleBindings.map(binding=>binding.roleId==='spikes'?{...binding,label:'bear'}:binding);
 const proof=runBot(made.world,undefined,{roleBindings:renamed,probeBody:target.body}).witnesses;
 expect(proof.some(w=>matchesWitness({actor:'bear',verb:'obstacle',object:'penguin'},w))).toBe(true);
 expect(proof.some(w=>matchesWitness({actor:'iceberg',verb:'obstacle',object:'penguin'},w))).toBe(false);
});
