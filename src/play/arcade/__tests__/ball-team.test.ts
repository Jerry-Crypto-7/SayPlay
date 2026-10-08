import { beforeAll, expect, it } from 'vitest';
import { BODY, COUNTER, HEADER, NO_INPUT, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { opponentBallEvidence, type BallEffectObservation } from '../ball-evidence';
import type { RulePiece } from '../contract';
import { ballLaunch, ballScore, ballPitch } from '../pieces/ball';
import { runBot } from '../verify';

const worldOf = (seed: number, goal: 'goal' | 'hoop' | 'hole' = 'goal') => {
 const params = ballPitch.params.parse({ team: true, goal });
 const result = buildWorld({ seed, ...ballPitch.parts(seed, params, undefined) }, ARCADE_LIBRARY);
 if (!result.ok) throw new Error(result.issues.join('; '));
 return result.world;
};
beforeAll(loadRapier);
it('a ball team fields a physical keeper and forward; the bot wins all five seeds', () => {
 for (const goal of ['goal', 'hoop', 'hole'] as const) for(let seed=1;seed<=5;seed++) {
  const world=worldOf(seed,goal), bot=runBot(world,ARCADE_LIBRARY,{planner:false});
  expect(bot.outcome, `${goal}/${seed}`).toBe('won');
  expect(replay(world,bot.inputs,ARCADE_LIBRARY).hash).toBe(bot.hash);
 }
},120000);
it('idle loses from actual opposing goals, and moving the home goal makes those shots miss', () => {
 const world=worldOf(1);
 for(const miss of [false,true]) {
  const state=instantiate(world), program=loadProgram(world,ARCADE_LIBRARY);
  const goal=world.kinds.indexOf('home-goal');
  if(miss) for(let i=0;i<state[HEADER.bodyCount]!;i++) if(state[bodyBase(i)+BODY.kind]===goal) state[bodyBase(i)+BODY.x]=15000;
  try {
   for(let tick=0;tick<600 && outcomeOf(state)==='running';tick++) step(state,NO_INPUT,program);
   expect(state[HEADER.counters+COUNTER.reserve]).toBe(miss ? 0 : 2);
   expect(outcomeOf(state)).toBe(miss ? 'running' : 'lost');
  }finally{releasePhysics(state);}
 }
});

it('opponent shot and goal evidence requires actual physical effects, not a timer or count alone', () => {
 const world=worldOf(1), state=instantiate(world);
 const pending: Omit<BallEffectObservation, 'after'>[]=[];
 const wrap=<P,>(piece: RulePiece<P>): RulePiece<P> => ({...piece,fire(ctx,params){
  const before=ctx.state.slice(), effects=piece.fire(ctx,params);
  if(effects.length) pending.push({world,rule:world.rules.findIndex(r=>r.id===piece.id),before,effects});
  return effects;
 }});
 const program=loadProgram(world,{...ARCADE_LIBRARY,rules:{...ARCADE_LIBRARY.rules,ball_launch:wrap(ballLaunch),ball_score:wrap(ballScore)}});
 const observations: BallEffectObservation[]=[];
 try {
  for(let tick=0;tick<600 && outcomeOf(state)==='running';tick++) {
   step(state,NO_INPUT,program);
   observations.push(...pending.splice(0).map(o=>({...o,after:state.slice()})));
  }
  const evidence=observations.flatMap(opponentBallEvidence);
  expect(evidence.filter(e=>e.event==='shot')).toHaveLength(2);
  expect(evidence.filter(e=>e.event==='goal')).toHaveLength(2);
  const scoring=observations.find(o=>opponentBallEvidence(o).some(e=>e.event==='goal'))!;
  expect(opponentBallEvidence({...scoring,effects:[]})).toEqual([]);
  const fake=Int32Array.from(scoring.before);
  const ball=opponentBallEvidence(scoring)[0]!.ball;
  fake[bodyBase(ball)+BODY.x]=100000;
  expect(opponentBallEvidence({...scoring,before:fake})).toEqual([]);
 }finally{releasePhysics(state);}
});
