import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { ALLOWED, assemblyOfCell } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { HEADER, COUNTER } from '@/play/arcade/contract';
import { ballLaunch } from '@/play/arcade/pieces/ball';
// Experiment: actual launch recovery changes, not a production acceptance report.
it('compares visible deadline and launch recovery candidates', async () => {
  await loadRapier(); const rows = [];
  for (const cell of ALLOWED.filter(c => c.id === 'ball.score+rival')) {
    const pins = cell.recipe.objective === 'defeat', keeper = cell.recipe.threats.includes('rival');
    const targets = pins ? 3 : 5, seconds = pins ? 10 : keeper ? 16 : 15;
    for (const recovery of [177,178,179]) {
      const library = { ...ARCADE_LIBRARY, rules: { ...ARCADE_LIBRARY.rules, ball_launch: { ...ballLaunch,
        fire: (...args: Parameters<typeof ballLaunch.fire>) => ballLaunch.fire(...args).map(e => e.kind === 'count' && e.counter === 'cooldown' && e.amount > 0 ? { ...e, amount: recovery + args[0].state[HEADER.counters + COUNTER.score]! * (pins ? 8 : 4) } : e)
      } } };
      const wins = { novice:0, intermediate:0, expert:0 }; const ticks:number[] = [];
      for(let seed=1; seed<=20; seed++) {
        const base = compileRecipe(assemblyOfCell(cell));
        const made = arcadeWorldOf({...base,controlParams:{...base.controlParams,targets},mechanics:[{id:'timer',params:{id:'clock',seconds,onEnd:'lose'}}]},seed);
        if(!made.ok)throw Error(made.issues.join(';'));
        for(const profile of ['novice','intermediate','expert'] as const){
          const run=runBot(made.world,library,{planner:false,...(profile==='expert'?{}:{profile})});
          wins[profile]+=Number(run.outcome==='won'); if(profile==='expert')ticks.push(run.tick);
        }
      }
      rows.push({cell:cell.id,targets,seconds,recovery,wins,ticks});
      writeFileSync('.claude/scratchpads/p41-ball-keeper-ramp.json',JSON.stringify(rows,null,2));
    }
  }
},600000);