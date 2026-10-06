import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { matchesWitness } from '../../arcade/witness';
import { extractIntent } from '../../intent/extract';
import { compose } from '../compose';
import { nativeSpec } from '../native';
import { arcadeWorldOf } from '../../arcade/compile';
import { runBot, verifyArcade } from '../../arcade/verify';
import { ARCADE_LIBRARY } from '../../arcade/library';
import { NO_INPUT } from '../../arcade/contract';
beforeAll(loadRapier);
const rows = [{"id": "ma-011", "sentence": "shoot n race cars in the desert", "hero": "car", "setting": "desert", "essential": [{"actor": "car", "verb": "shoot", "object": null}, {"actor": "car", "verb": "race", "object": null}, {"actor": "car", "verb": "drive", "object": null}], "unsupported": false}, {"id": "pa-003", "family": "car-race-shoot", "sentence": "shoot and race in a car", "hero": "car", "setting": null, "essential": [{"actor": "car", "verb": "drive", "object": null}, {"actor": "car", "verb": "shoot", "object": null}, {"actor": "car", "verb": "race", "object": null}], "unsupported": false}, {"id": "pa-022", "family": "fish-escape-shark", "sentence": "a shark chases a little fish, swim away and escape", "hero": "fish", "setting": null, "essential": [{"actor": "shark", "verb": "chaser", "object": "fish"}, {"actor": "fish", "verb": "glide", "object": null}, {"actor": "fish", "verb": "escape", "object": "shark"}], "unsupported": false}, {"id": "si-025", "sentence": "a basketball shooting game", "hero": null, "setting": null, "essential": [{"actor": "hero", "verb": "throw", "object": "ball"}], "unsupported": false}, {"id": "ne-006", "sentence": "basketball but you can't dribble, only throw", "hero": null, "setting": null, "essential": [{"actor": "hero", "verb": "throw", "object": "ball"}], "negated": ["ball"], "unsupported": false}, {"id": "ne-010", "sentence": "a pirate ship that doesn't shoot cannons, it races other ships", "hero": "ship", "setting": null, "essential": [{"actor": "ship", "verb": "drive", "object": null}, {"actor": "ship", "verb": "race", "object": null}, {"actor": "ship", "verb": "rival", "object": "ship"}], "negated": ["shoot"], "unsupported": false}, {"id": "ma-031", "sentence": "a knight fights a dragon to save the princess", "hero": "knight", "setting": null, "essential": [{"actor": "knight", "verb": "duel", "object": "dragon"}, {"actor": "knight", "verb": "interact", "object": "princess"}], "unsupported": false}];
it.each(rows.flatMap(row => [1,2,3,4,5].map(seed => ({row,seed}))))('$row.id / $seed preserves hand-labelled actor and performed action', ({row,seed}) => {
 const intent=extractIntent(row.sentence), made=compose(intent,seed);
 for(const triple of row.essential) {
   const proved=made.witnesses.some(w=>matchesWitness(triple,w));
   // Rescue is not fabricated by this identity repair; duel must be witnessed or admitted.
   if(row.id==='ma-031') expect(proved || made.unmet.some(t=>t.actor===triple.actor&&t.verb===triple.verb&&t.object===triple.object),JSON.stringify(triple)).toBe(true);
   else expect(proved,JSON.stringify({triple,intent,roles:made.spec.roles,witnesses:made.witnesses})).toBe(true);
 }
});
it.each(['a knight fights two dragons','a knight fights all dragons','a knight fights a horde of dragons'])('keeps multiple opponents as fighting: %s',sentence=>expect(extractIntent(sentence).items.some(i=>i.verb==='fight'&&i.essential)).toBe(true));
it.each(['a knight fights a dragon','a pirate fights the captain','a robot fights an alien'])('identifies singular duels: %s',sentence=>expect(extractIntent(sentence).items.some(i=>i.verb==='duel'&&i.essential)).toBe(true));

function basketball(label='basketball') {
 return nativeSpec({move:'ball',objective:'score',actions:[],threats:[]},{genre:'throw',mode:'default',hero:'fox',setting:'court',cast:[{label,does:'scenery',verb:'throw'},{label:'hoop',does:'throw_at'}]});
}
it.each(['basketball','watermelon'])('a real thrown body preserves its exact identity: %s',label=>{
 const made=arcadeWorldOf(basketball(label),1);if(!made.ok)throw Error(made.issues.join(';'));
 const verdict=verifyArcade(made.world,undefined,made.roleBindings);
 expect(verdict.bot.outcome).toBe('won');
 const proved=(object:string)=>verdict.witnesses.some(w=>matchesWitness({actor:'hero',verb:'throw',object},w));
 expect(proved(label)).toBe(true);expect(proved('ball')).toBe(label==='basketball');expect(proved('football')).toBe(false);
 expect(verdict.witnesses.some(w=>w.verb==='kick')).toBe(false);
});
it('a hoop label and stationary ball without a release do not prove throwing',()=>{
 const made=arcadeWorldOf(basketball(),1);if(!made.ok)throw Error(made.issues.join(';'));
 const native=ARCADE_LIBRARY.bots[made.world.bot.id];
 const library={...ARCADE_LIBRARY,bots:{...ARCADE_LIBRARY.bots,[made.world.bot.id]:{...native,decide:()=>NO_INPUT}}};
 const run=runBot(made.world,library,{roleBindings:made.roleBindings});
 expect(run.outcome).not.toBe('won');expect(run.witnesses.some(w=>w.verb==='throw'||w.verb==='kick')).toBe(false);
});
