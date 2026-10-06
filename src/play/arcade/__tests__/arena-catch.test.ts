import { expect, it } from 'vitest';
import { arenaCatch, arenaCatchContact, arenaCatchParams } from '../pieces/arena-catch';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { verifyArcade, runBot } from '../verify';
import { bindRoles } from '../witness';
import { catchSpec } from '@/play/compose/catch';
import { enemyModel } from '../models';
import { canonicalHash } from '@/ir/worlddoc';
const library = { ...ARCADE_LIBRARY, rules: { ...ARCADE_LIBRARY.rules, arena_catch_contact: arenaCatchContact } };
const recipe = { move: 'roam', objective: 'catch', actions: [], threats: [] } as const;
it('renders the named prey rather than the default enemy', () => {
  const spec = catchSpec({ ...recipe, actions: [], threats: [] }, { genre: 'arena', mode: 'collect', hero: 'dog', setting: 'park', cast: [{ label: 'cat', does: 'fight' }] });
  expect(enemyModel(spec)).toBe('rigged:pet-cat');
});
function made(seed: number, hero = 'dog', prey = 'cat', staticPrey = false) {
  const spec = catchSpec({ ...recipe, actions: [], threats: [] }, { genre: 'arena', mode: 'collect', hero, setting: 'park', cast: [{ label: prey, does: 'fight' }] });
  const parts = arenaCatch.parts(seed, arenaCatchParams.parse({ half: 40000, preySpeed: 250, catchSeconds: 11 }), undefined);
  const level = staticPrey ? { ...parts.level, bodies: parts.level.bodies.map((b,i)=>i===1?{...b,kinematic:false}:b) } : parts.level;
  const built = buildWorld({ seed, ...parts, level }, library);
  if (!built.ok) throw new Error(built.issues.join(';'));
  return { world: built.world, bindings: bindRoles(spec, built.world) };
}
it.each([1,2,3,4,5])('seed %s catches moving prey with exact identities, replay and no idle win', seed => {
  for (const [hero,prey] of [['dog','cat'],['cat','dog']]) {
    const m=made(seed,hero,prey), verdict=verifyArcade(m.world,library,m.bindings);
    expect(verdict.failures).toEqual([]);
    expect(verdict.idle.outcome).toBe('lost');
    expect(verdict.replayEqual).toBe(true);
    expect(canonicalHash(m.world)).toBe(canonicalHash(made(seed,hero,prey).world));
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({verb:'catch',evidence:'moving-prey-contact',actor:expect.objectContaining({label:hero}),object:expect.objectContaining({label:prey})}));
    expect(verdict.witnesses.some(w=>w.verb==='catch'&&w.actor.label===prey)).toBe(false);
    expect(m.world.rules.some(r=>['grow_to','arena_eat','score_bonus'].includes(r.id))).toBe(false);
  }
});
it('static prey cannot substitute for a chase', () => {
 const m=made(1,'dog','cat',true), run=runBot(m.world,library,{roleBindings:m.bindings});
 expect(run.outcome).toBe('lost'); expect(run.witnesses.some(w=>w.verb==='catch')).toBe(false);
});

it('live assembly is validated and compiled through the real schema', async () => {
 const { readGameSpec } = await import('@/play/spec');
 const { arcadeWorldOf } = await import('../compile');
 const { ALLOWED, assemblyOfCell } = await import('@/play/compose/allowed');
 const { compileRecipe } = await import('@/play/compose/compile');
 const cell=ALLOWED.find(c=>c.id==='roam.catch')!;
 expect(cell.status).toBe('live');
 const spec=compileRecipe(assemblyOfCell(cell));
 const read=readGameSpec(spec); if(!read.ok)throw new Error(read.issues.join(';'));
 const made=arcadeWorldOf(spec,1);if(!made.ok)throw new Error(made.issues.join(';'));
 expect(verifyArcade(made.world,undefined,made.roleBindings).publishEligible).toBe(true);
});

it('actual pursuit moves from wandering at distance to flight when approached', async () => {
 const { moveFreeControl, ARENA }=await import('../pieces/arena');
 const { BODY, bodyBase }=await import('../contract');
 const m=made(1); let far=false, fleeing=false;
 const observed={...library,controls:{...library.controls,move_free:{...moveFreeControl,step(...args: Parameters<typeof moveFreeControl.step>){
   const [state,player,input,params]=args;
   const p=bodyBase(player),q=bodyBase(1),dx=state[q+BODY.x]!-state[p+BODY.x]!,dz=state[q+BODY.z]!-state[p+BODY.z]!;
   moveFreeControl.step(state,player,input,params);
   if(Math.abs(dx)+Math.abs(dz)>=ARENA.fleeRadius)far=true;
   else if(dx*state[q+BODY.vx]!+dz*state[q+BODY.vz]!>0)fleeing=true;
 }}}};
 expect(runBot(m.world,observed).outcome).toBe('won');expect(far).toBe(true);expect(fleeing).toBe(true);
});
it.each([1,2,3,4,5])('default agar movement retains the original speed45, seed %s', async seed => {
 const { arenaLevel,arenaControlRef,arenaBotRef,arenaRules }=await import('../pieces/arena');
 const params=arenaLevel.params.parse({}),level=arenaLevel.generate(seed,params);
 const parts={seed,level,control:arenaControlRef(),bot:arenaBotRef(),rules:arenaRules(level,params)};
 const a=buildWorld(parts,library),b=buildWorld({...parts,control:{...parts.control,params:{...parts.control.params,preySpeed:45}}},library);
 if(!a.ok||!b.ok)throw new Error('legacy arena did not build');
 const first=runBot(a.world,library),second=runBot(b.world,library);
 expect(second.hash).toBe(first.hash);expect(second.inputs).toEqual(first.inputs);expect(second.outcome).toBe(first.outcome);
});
