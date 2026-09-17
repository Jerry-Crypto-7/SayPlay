import { describe, expect, it } from 'vitest';
import { buildRuntimeWorld } from '../../ir/build';
import { solveWitnessDetailed } from '../solve';
import { verifyWitness } from '../witness';

const budget={maxNodes:20_000,maxTicks:40_000,maxDepth:6,settleTicks:30};
function world(delayed:boolean) {
  const built=buildRuntimeWorld({
    layout:{width:4,height:16},
    sockets:{origin:[2,1],destination:[2,13],approach:[2,11]},
    entities:{operator:{role:'actor',socket:'origin',state:'idle'},terminal:{role:'device',socket:'destination',state:'idle'}},
    state:{counters:{},flags:{ready:false},timers:{delay:{durationTicks:240,initial:0}},zones:{},slots:0},
    rules:{
      ...(delayed?{
        start:{event:{kind:'onStart'},condition:null,actions:[{kind:'startTimer',timer:'delay'}]},
        ready:{event:{kind:'onTimerEnd',timer:'delay'},condition:null,actions:[{kind:'setFlag',ref:'ready',value:true}]},
      }:{}),
      complete:{event:{kind:'onAction',actor:'operator',actionId:'activate',target:'terminal'},
        condition:delayed?{kind:'flagIs',ref:'ready',value:true}:{kind:'inZone',entity:'operator',zone:'approach'},
        actions:[{kind:'win'}]},
    },witness:{tier:'short',H_cert:600,ops:[]},
  });
  if(!built.ok)throw new Error(JSON.stringify(built.issues));
  return built.world;
}

describe('bounded temporal witness search',()=>{
  it('finds a delayed first action without requiring repeated dummy inputs',()=>{
    const doc=world(true);
    expect(verifyWitness(doc,[{tick:270,actor:'operator',actionId:'activate',target:'terminal'}]).verdict).toBe('CERTIFIED');
    const found=solveWitnessDetailed(doc,budget);
    expect(found.status).toBe('solved');
    expect(found.result?.ops).toHaveLength(1);
    expect(found.result!.ops[0].tick).toBeGreaterThan(150);
    expect(found.ticks).toBeLessThanOrEqual(budget.maxTicks);
    expect(found.nodes).toBeLessThanOrEqual(budget.maxNodes);
    expect(solveWitnessDetailed(doc,budget)).toEqual(found);
  });
  it('finds an action during a transient position between coarse settle ticks',()=>{
    const doc=world(false);
    const trace=[{tick:0,actor:'operator',actionId:'moveTo',target:'terminal'},{tick:11,actor:'operator',actionId:'activate',target:'terminal'}];
    expect(verifyWitness(doc,trace).verdict).toBe('CERTIFIED');
    const found=solveWitnessDetailed(doc,budget);
    expect(found.status).toBe('solved');
    expect(found.result!.ops).toEqual(trace);
    expect(found.ticks).toBeLessThanOrEqual(budget.maxTicks);
  });
  it('reports budget exhaustion separately and never spends beyond a tiny bound',()=>{
    const found=solveWitnessDetailed(world(true),{...budget,maxTicks:10});
    expect(found.status).toBe('budget-exhausted');
    expect(found.result).toBeNull();
    expect(found.ticks).toBe(10);
  });
  it('does not claim search-exhausted means logically unwinnable',()=>{
    const found=solveWitnessDetailed(world(false),{...budget,maxDepth:0});
    expect(found.status).toBe('search-exhausted');
    expect(found.result).toBeNull();
  });
});
