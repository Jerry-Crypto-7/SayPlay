import { expect, it } from 'vitest';
import { compileRecipe } from '@/play/compose/compile';
import { namedProjectiles } from '@/play/compose/projectiles';
import type { RecipeAssembly } from '@/play/compose/presets';
import type { GenreSpec } from '@/play/genre/contract';
import { arcadeWorldOf } from '../compile';
import { BODY, BUTTON, HEADER, ROLE, bodyBase, type ArcadeEffect } from '../contract';
import { instantiate, loadProgram, step, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot, verifyArcade } from '../verify';
import { WitnessRecorder } from '../witness';

it('separates named ammunition from targets and negated or directional target phrases',()=>{
  expect(namedProjectiles('A jeep firing rockets at drones.')).toEqual([{label:'rocket',target:'drone'}]);
  expect(namedProjectiles('A submarine firing torpedoes and delivering medicine.')).toEqual([{label:'torpedo',target:null}]);
  expect(namedProjectiles('A wizard fires fireballs into robots.')).toEqual([{label:'fireball',target:'robot'}]);
  expect(namedProjectiles('Shoot at rockets and shoot down missiles.')).toEqual([]);
  expect(namedProjectiles('Shoot drones and rockets.')).toEqual([]);
  expect(namedProjectiles('Do not fire rockets.')).toEqual([]);
});

function recipe(move:'drive'|'glide'|'stationary'):RecipeAssembly {
  const content:GenreSpec={...(move==='stationary'?{genre:'shooter',mode:'default'} as const:{genre:'voyage',mode:'race'} as const),hero:move==='glide'?'submarine':'robot',setting:'forest',cast:[{label:'drone',does:'shoot_at'},{label:move==='glide'?'torpedo':'rocket',does:'scenery',verb:'shoot'}]};
  return {preset:move==='stationary'?'shooter.default':'assembled',move,actions:['shoot'],objective:move==='stationary'?'defeat':'reach',threats:[],content};
}
function made(assembly:RecipeAssembly,seed=1){const result=arcadeWorldOf(compileRecipe(assembly),seed);if(!result.ok)throw new Error(result.issues.join(';'));return result;}

it.each(['drive','glide','stationary'] as const)('%s proves named launched ammunition and retains distinct target hit proof',move=>{
  const assembly=recipe(move),built=made(assembly);
  const plain=made({...assembly,content:{...assembly.content,cast:assembly.content.cast!.filter(item=>item.does!=='scenery')}});
  expect(built.world).toEqual(plain.world);
  const verdict=verifyArcade(built.world,undefined,built.roleBindings);
  expect(verdict.publishEligible,verdict.failures.join(';')).toBe(true);
  expect(verdict.replayEqual).toBe(true);
  const ammo=verdict.witnesses.find(w=>w.verb==='shoot'&&w.object?.roleId==='ammunition');
  expect(ammo).toMatchObject({object:{label:move==='glide'?'torpedo':'rocket'},evidence:'launched-projectile-moved',run:'winner'});
  expect(ammo!.object!.body).toBeGreaterThanOrEqual(built.world.initial[HEADER.spawnBase]!);
  expect(verdict.witnesses.some(w=>w.verb==='shoot'&&w.object?.label==='drone'&&w.evidence==='projectile-hit')).toBe(true);
  expect(runBot(plain.world,undefined,{roleBindings:plain.roleBindings}).witnesses.some(w=>w.object?.roleId==='ammunition')).toBe(false);
},30000);

it.each(['no-fire','no-spawn','no-motion'] as const)('a named ammunition role alone gives no proof: %s',mode=>{
  const built=made(recipe('drive'));
  const original=ARCADE_LIBRARY.rules.blaster!;
  const library:ArcadeLibrary=mode==='no-fire'?ARCADE_LIBRARY:{...ARCADE_LIBRARY,rules:{...ARCADE_LIBRARY.rules,blaster:{...original,fire:(ctx,params)=>original.fire(ctx,params).flatMap<ArcadeEffect>(effect=>effect.kind!=='spawn'?[effect]:mode==='no-spawn'?[]:[{...effect,vx:0,vy:0,vz:0}])}}};
  const recorder=new WitnessRecorder(built.world,built.roleBindings,'winner','counterfactual');
  const program=loadProgram(built.world,recorder.observe(library)),state=instantiate(built.world);
  for(let tick=0;tick<40;tick++){
    const before=state.slice();
    step(state,{buttons:mode==='no-fire'?0:BUTTON.FIRE,axis:0},program,(rule,effect)=>recorder.effect(rule,effect,state,tick));
    recorder.afterTick(before,state,tick);
  }
  expect(recorder.finish('won').some(w=>w.object?.roleId==='ammunition')).toBe(false);
  const template=built.roleBindings.find(b=>b.roleId==='ammunition')!;
  expect(state[bodyBase(template.body)+BODY.role]).toBe(ROLE.projectile);
});
