import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {voyageRace,steerControl} from '../pieces/steer';
import {arcadeWorldOf} from '../compile';
import {BODY,COUNTER,HEADER,NO_INPUT,ROLE,FLAG,bodyBase,rampedSpeed,type PieceRef} from '../contract';
import {baseControlOf} from '../addons';
import {type Phase,phaseSpeed} from '../../compose/progression';
import {instantiate,loadProgram,step} from '../kernel';
import {runBot} from '../verify';
import {ARCADE_LIBRARY} from '../library';
import {liveCells,assemblyOfCell} from '../../compose/allowed';
import {compileRecipe} from '../../compose/compile';
import {readRecipeContent} from '../../director/read';
import {readGameSpec} from '../../spec';
const pins=[{"seed":1,"params":{},"hash":"9698ff1ff5792d39aeca19b2e85f6c2f5cecded878a92071c1f410595326f51b"},{"seed":1,"params":{"sections":3},"hash":"19083aad4123ad7626877665e9476d15f02cc5f25e680bb977b21921ee64bb2a"},{"seed":2,"params":{},"hash":"3d28461d8048641c2458338dc46c6f72f8cc58a5645dbf09ecfcd457b7e81117"},{"seed":2,"params":{"sections":3},"hash":"048cd3849d177c051fd7ae4f66e1925a6fbdf2254e872125694045cfc8ce6855"},{"seed":3,"params":{},"hash":"58d26abfe416c883b0f140099499ca180fcba0422a4705e93e40bf55d4081d37"},{"seed":3,"params":{"sections":3},"hash":"35fec45f435cb463e85cec0b9d20be5a428ec66794650708957263e265d175cb"},{"seed":4,"params":{},"hash":"db8d25c8695df83fc845e7f97cb65b4e23a48c19aee796439a8b15b62ae3170f"},{"seed":4,"params":{"sections":3},"hash":"1d2c864b87cab21c71ac86a45f7e10ac8b17a8def0f68159798ba1c6281bed65"},{"seed":5,"params":{},"hash":"cef72b6a783bccdbad03df7abccc36d7e293d33e16c10c9951412452be8b9aab"},{"seed":5,"params":{"sections":3},"hash":"6bfcb3251af9ac7ed2424ad89e2af6e82587cd693c10bf020ed9fe481ad13bac"}];
it('preserves both frozen legacy voyage variants without opt-in settings',()=>{for(const row of pins)expect(createHash('sha256').update(JSON.stringify(voyageRace.parts!(row.seed,voyageRace.params.parse(row.params),3))).digest('hex')).toBe(row.hash);});
it('validates exact recipe bounds and includes actual body/rule costs',()=>{
const cell=liveCells().find(c=>c.id==='voyage.race')!;for(const params of[{hazards:2},{turbo:2},{roadWidth:3599},{roadEntryWidth:10001},{crashBudget:0}])expect(readRecipeContent(cell,{params}).ok).toBe(false);
const params=voyageRace.params.parse({hazards:false,turbo:true,roadWidth:3600,roadEntryWidth:4000,crashBudget:1,lengthM:700});const parts=voyageRace.parts!(1,params,3),cost=voyageRace.cost(params);expect(parts.level.bodies.length).toBeLessThanOrEqual(cost.bodies);expect(parts.rules.length).toBeLessThanOrEqual(cost.rules);expect(parts.level.bodies.some(b=>b.role==='hazard')).toBe(false);expect(parts.level.bodies.some(b=>b.kind==='turbo'&&b.role==='collectible')).toBe(true);expect(parts.health).toBe(1);
});
it('collects visible turbo bodies and really accelerates the boat in the actual recipe',()=>{
const cell=liveCells().find(c=>c.id==='voyage.race')!,spec=compileRecipe(assemblyOfCell(cell));expect(readGameSpec(spec).ok).toBe(true);expect(spec.tutorial?.controlsHint).toContain('Banks end run');expect(spec.roles.some(r=>r.id==='turbo'&&r.kind==='collectible')).toBe(true);const made=arcadeWorldOf(spec,1);if(!made.ok)throw Error(made.issues.join(';'));const run=runBot(made.world);expect(run.outcome).toBe('won');const state=instantiate(made.world),program=loadProgram(made.world,ARCADE_LIBRARY),params=steerControl.params.parse(baseControlOf(made.world.control).params),p=bodyBase(0);let cursor=0,boosted=false,picked=false;
// Průběh (P45C T11) obalí řízení fázemi: běžná rychlost je pak fáze, ne rampa.
const under=(ref:PieceRef):PieceRef|undefined=>ref.id==='phase_control'?ref:typeof ref.params.base==='object'?under(ref.params.base as PieceRef):undefined,phase=under(made.world.control)?.params as {phases:Phase[];length:number}|undefined;
const cruise=(z:number)=>phase===undefined?rampedSpeed(params.topSpeed,z,params.ramp):phaseSpeed(params.topSpeed,z,phase.length,phase.phases);
for(let tick=0;tick<run.tick;tick++){const event=run.inputs[cursor];step(state,event?.tick===tick?event:NO_INPUT,program);if(event?.tick===tick)cursor++;picked ||= state[HEADER.counters+COUNTER.score]!>0;boosted ||= state[p+BODY.vz]!>cruise(state[p+BODY.z]!);}
expect(picked).toBe(true);expect(boosted).toBe(true);expect(Array.from({length:state[HEADER.bodyCount]!},(_,i)=>bodyBase(i)).some(b=>state[b+BODY.role]===ROLE.collectible&&(state[b+BODY.flags]!&FLAG.alive)===0)).toBe(true);
});
