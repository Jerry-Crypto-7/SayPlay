import { beforeAll, expect, it } from 'vitest';
import { compileRecipe } from '../../compose/compile';
import type { GenreSpec } from '../../genre/contract';
import { arcadeWorldOf } from '../compile';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { verifyArcade } from '../verify';
import { matchesWitness } from '../witness';

const moves = ['run', 'jump', 'flap', 'drive', 'roam', 'glide', 'walk', 'ball'] as const;
const kinds = ['deliver', 'interact', 'fight', 'duel', 'chaser'] as const;
const contentOf = (move: typeof moves[number]): GenreSpec => {
 const hero='robot',setting='forest';
 if(move==='drive'||move==='glide')return {genre:'voyage',mode:'race',hero,setting};
 if(move==='walk')return {genre:'quest',mode:'spatial',hero,setting};
 if(move==='roam')return {genre:'arena',mode:'collect',hero,setting};
 return {genre:move==='run'?'runner':move==='jump'?'platformer':move==='flap'?'flap':'throw',mode:'default',hero,setting};
};
beforeAll(async()=>{await loadRapier();});
it.each(moves.flatMap(move=>kinds.map(kind=>({move,kind}))))('$move + $kind is playable, witnessed, deterministic and cannot be won idle',({move,kind})=>{
 const label=kind==='deliver'?'parcel':kind==='interact'?'princess':'bear';
 const spec=compileRecipe({preset:'assembled',move,actions:kind==='chaser'?[]:[kind],objective:'reach',threats:kind==='chaser'?['chaser']:[],content:contentOf(move),
  parts:[{kind,role:'part_0',label,phase:0,motion:'fall'}]});
 const built=arcadeWorldOf(spec,1);
 if(!built.ok)throw new Error(built.issues.join('; '));
 const verdict=verifyArcade(built.world,ARCADE_LIBRARY,built.roleBindings);
 expect.soft(verdict.bot.outcome,`${move}/${kind}: tick ${verdict.bot.tick}`).toBe('won');
 expect.soft(verdict.publishEligible,JSON.stringify(verdict.failures)).toBe(true);
 expect.soft(verdict.replayEqual).toBe(true);
 const triple=kind==='chaser'?{actor:label,verb:kind,object:'robot'}:{actor:'robot',verb:kind,object:label};
 expect.soft(verdict.witnesses.some(w=>matchesWitness(triple,w)),`missing ${JSON.stringify(triple)}`).toBe(true);
 expect.soft(verdict.witnesses.some(w=>matchesWitness({actor:'robot',verb:move,object:null},w)),`missing ${move} movement`).toBe(true);
 const idle=replay(built.world,[],ARCADE_LIBRARY);
 expect.soft(idle.outcome,'idle must not complete the combined game').not.toBe('won');
},30000);
