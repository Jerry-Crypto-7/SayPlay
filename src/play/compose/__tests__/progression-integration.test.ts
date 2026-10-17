import { DIRECTOR_EXAMPLES, exampleGame, exampleReady } from '../../director/retrieval';
﻿import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '../../arcade/compile';
import { runBot } from '../../arcade/verify';
import { ARCADE_LIBRARY } from '../../arcade/library';
import { driveSpec } from '../drive';
import { nativeSpec } from '../native';
import { replay } from '../../arcade/kernel';
import { canonicalHash } from '@/ir/worlddoc';
import { compileRecipe } from '../compile';
import { compose } from '../compose';
import { extractIntent } from '../../intent/extract';
import { gameSpecSchema } from '../../spec';
import { recipeSchema } from '../recipe';
import { recipeAnswerSchema } from '../../director/answer-schema';

const sentences = { drive: 'a car races against another car', glide: 'a fish swims through a coral reef', walker: 'a cat walks to the exit', runner: 'a robot runs to the finish' };
const phases = [{ start: 0, speedPercent: 100, add: [{ role: 'collectible' as const, count: 1 }] }, { start: 500, speedPercent: 110, add: [{ role: 'obstacle' as const, count: 1 }] }];
const graph = [{ goal: 'key', prerequisites: [] }, { goal: 'gate', prerequisites: ['key'] }];
const cases = Object.entries(sentences).flatMap(([move,sentence])=>Array.from({length:5},(_,i)=>({move,sentence,seed:i+1})));

describe('T26 public recipe to actual progression simulation', () => {
  it.each(cases)('$move seed $seed keeps unchanged defaults and plays phases/dependencies', ({move, sentence, seed}) => {
    const assembly = compose(extractIntent(sentence), seed).recipe;
    const content = {genre:'voyage' as const,mode:'race' as const,hero:'fish',setting:'coral reef'};
    const ordinary = move === 'drive' ? driveSpec({move:'drive',actions:[],objective:'reach',threats:[]},content) : move === 'glide' || move === 'walker' ? nativeSpec({move:move === 'walker' ? 'walk' : 'glide',actions:[],objective:'reach',threats:[]},content) : compileRecipe(assembly);
    expect(ordinary).not.toHaveProperty('phases'); expect(ordinary).not.toHaveProperty('dependsOn');
    const original = arcadeWorldOf(ordinary, seed);
    const same = arcadeWorldOf({...ordinary},seed);
    if (!original.ok || !same.ok) throw Error('Baseline could not build');
    expect(canonicalHash(original.world)).toBe(canonicalHash(same.world));
    const paced = {...ordinary, phases};
    const spec = {...paced, roles: [...paced.roles, {...paced.roles[0]!, id:'key',kind:'key' as const,label:'key'}, {...paced.roles[0]!,id:'gate',kind:'door' as const,label:'gate'}], dependsOn:graph};
    expect(gameSpecSchema.safeParse(spec).success).toBe(true);
    const made = arcadeWorldOf(spec,seed);
    if (!made.ok) throw Error(made.issues.join('; '));
    const bot = runBot(made.world,undefined,{planner:false});
    expect(bot.outcome).toBe('won');
    expect(replay(made.world,bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(canonicalHash(made.world)).not.toBe(canonicalHash(original.world));
  });
  it('accepts bounds in the recipe answer and rejects cycles before simulation', () => {
    const recipe = {...compose(extractIntent(sentences.drive)).recipe, phases, dependsOn:graph};
    const {preset:_,content,parts:_parts,intent:_intent,...plain}=recipe;
    expect(recipeSchema.safeParse(plain).success).toBe(true);
    const {genre:_genre,mode:_mode,...answerContent}=content;
    expect(recipeAnswerSchema.safeParse({...answerContent,recipe:plain,unmet:[]}).success).toBe(true);
    expect(recipeSchema.safeParse({...plain,dependsOn:[{goal:'key',prerequisites:['key']}]}).success).toBe(false);
  });
});

it('compiles an explicit public goal graph into real keys and gates', () => {
  const assembly = compose(extractIntent(sentences.drive)).recipe;
  const spec = compileRecipe({...assembly, phases, dependsOn: [{goal:'key',action:'collect',label:'brass key',prerequisites:[]},{goal:'gate',action:'open',label:'garage door',prerequisites:['key']}]});
  expect(spec.roles).toContainEqual(expect.objectContaining({id:'gate',kind:'door',label:'garage door'}));
  const made=arcadeWorldOf(spec,1); if(!made.ok) throw Error(made.issues.join('; '));
  const played = runBot(made.world,undefined,{planner:false,roleBindings:made.roleBindings});
  expect(played.outcome).toBe('won');
  expect(played.witnesses.some(w => w.verb === 'collect' && w.object?.roleId === 'key')).toBe(true);
  expect(played.witnesses.some(w => w.verb === 'open' && w.object?.roleId === 'gate')).toBe(true);
  expect(played.witnesses.some(w => w.verb === 'drive')).toBe(true);
  const bypass=arcadeWorldOf({...spec,rules:[{id:'bypass',verb:'open',when:{every:1},do:[{win:true}]}]},1);
  expect(bypass.ok).toBe(false);
});

it.each([1,2,3,4])('plays %i bounded speed phases with actual driving and shooting', count => {
  const ordinary=driveSpec({move:'drive',actions:['shoot'],objective:'reach',threats:[]},{genre:'voyage',mode:'race',hero:'car',setting:'city',cast:[{label:'zombie',does:'shoot_at'}]});
  const spec={...ordinary, phases:Array.from({length:count},(_,i)=>({start:Math.floor(i*1000/count),speedPercent:90+i*5}))};
  const made=arcadeWorldOf(spec,1); if(!made.ok) throw Error(made.issues.join('; '));
  const bot=runBot(made.world,undefined,{planner:false,roleBindings:made.roleBindings});
  expect(bot.outcome).toBe('won');
  expect(bot.witnesses.some(w=>w.verb==='shoot')).toBe(true);
  expect(bot.witnesses.some(w=>w.verb==='drive')).toBe(true);
  expect(replay(made.world,bot.inputs,ARCADE_LIBRARY).hash).toBe(bot.hash);
});

it('offers the new pacing example only through its real recipe compiler', () => {
 const example = DIRECTOR_EXAMPLES.find(example=>example.id==='p41-phases')!;
 expect(exampleReady(example)).toBe(true);
 const read=exampleGame(example);if(!read.ok)throw Error('Example did not parse');
 expect(read.spec.phases).toHaveLength(2);
 const made=arcadeWorldOf(read.spec,1);if(!made.ok)throw Error(made.issues.join('; '));
 expect(runBot(made.world,undefined,{planner:false}).outcome).toBe('won');
});
