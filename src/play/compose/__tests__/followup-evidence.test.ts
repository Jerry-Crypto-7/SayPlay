import {expect,it} from 'vitest';
import {compose} from '../compose';
import {extractIntent} from '../../intent/extract';
import {matchesWitness} from '../../arcade/witness';
import {arcadeWorldOf} from '../../arcade/compile';
import {runBot} from '../../arcade/verify';
import {instantiate,loadProgram,step} from '../../arcade/kernel';
import {ARCADE_LIBRARY} from '../../arcade/library';
import {BODY,HEADER,FLAG,NO_INPUT,bodyBase} from '../../arcade/contract';
const rows=[{"id": "ma-024", "sentence": "run through the forest, jump over logs and outrun a bear", "hero": null, "setting": "forest", "essential": [{"actor": "hero", "verb": "run", "object": null}, {"actor": "hero", "verb": "jump", "object": null}, {"actor": "log", "verb": "obstacle", "object": "hero"}, {"actor": "bear", "verb": "chaser", "object": "hero"}, {"actor": "hero", "verb": "escape", "object": "bear"}], "unsupported": false}, {"id": "ma-052", "sentence": "build a sandcastle on the beach before the tide washes it away", "hero": null, "setting": "beach", "essential": [{"actor": "hero", "verb": "build", "object": "sandcastle"}, {"actor": "tide", "verb": "hazard", "object": "hero"}], "unsupported": false}, {"id": "pa-012", "family": "ninja-sneak-treasure", "sentence": "be a ninja, slip past the guard patrol and take the treasure", "hero": "ninja", "setting": null, "essential": [{"actor": "ninja", "verb": "walk", "object": null}, {"actor": "guard", "verb": "guard", "object": "ninja"}, {"actor": "ninja", "verb": "collect", "object": "treasure"}], "unsupported": false}, {"id": "ne-017", "sentence": "a snowball fight but no throwing, you build snowmen instead", "hero": null, "setting": null, "essential": [{"actor": "hero", "verb": "build", "object": "snowman"}], "negated": ["throw"], "unsupported": false}];
it.each(rows.flatMap(row=>[1,2,3,4,5].map(seed=>({row,seed}))))('$row.id / $seed only confirms actually played actions',({row,seed})=>{
 const intent=extractIntent(row.sentence),made=compose(intent,seed);
 for(const triple of row.essential){
  const proven=made.witnesses.some(w=>matchesWitness(triple,w));
  if(row.id==='ma-024'&&triple.verb==='jump') {
   const built=arcadeWorldOf(made.spec,seed);if(!built.ok)throw Error(built.issues.join(';'));
   const run=runBot(built.world),state=instantiate(built.world),program=loadProgram(built.world,ARCADE_LIBRARY),inputs=new Map(run.inputs.map(i=>[i.tick,i]));
   let takeoff=false;const b=bodyBase(state[HEADER.player]);
   for(let tick=0;tick<run.tick;tick++) {const grounded=(state[b+BODY.flags]&FLAG.grounded)!==0,y=state[b+BODY.y];step(state,inputs.get(tick)??NO_INPUT,program);takeoff ||= grounded&&(state[b+BODY.flags]&FLAG.grounded)===0&&state[b+BODY.y]>y&&state[b+BODY.vy]>0;}
   expect(proven).toBe(takeoff);
   if(!takeoff)expect(made.unmet.some(t=>t.verb==='jump')).toBe(true);
  } else if(row.id==='pa-012'||row.id==='ma-024')expect(proven,JSON.stringify({triple,intent,roles:made.spec.roles})).toBe(true);
  else {expect(proven).toBe(false);expect(made.unmet.some(t=>t.actor===triple.actor&&t.verb===triple.verb&&t.object===triple.object)).toBe(true);}
 }
});
it('a bare patrol remains a named patrol, not a guard identity alias',()=>{
 const intent=extractIntent('a ninja sneaks past a patrol');expect(intent.items.some(t=>t.actor==='patrol'&&t.verb==='guard')).toBe(true);
});
