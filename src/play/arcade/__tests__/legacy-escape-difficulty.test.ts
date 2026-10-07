import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {arenaEscape,chaseParams,chaseSpeedOf} from '../pieces/arena';
import {HEADER,COUNTER} from '../contract';
import {readRecipeContent} from '../../director/read';
import {liveCells} from '../../compose/allowed';
const pins=[{"seed":1,"hash":"62d6df719744f7bc7a87effd05af55f3a02ea62679ee421890c1a8d7e75ab1eb"},{"seed":2,"hash":"b7c470e541f6276d45541f2c8e91d60ff98831477ba847dd4e9fb4be18facaa6"},{"seed":3,"hash":"95d3016bd1b42ee2f460715134a45697116ea4158586325492a6ec9951a2f807"},{"seed":4,"hash":"c9df5ac055243d411555f77311012c386fa851d9c2e927101bd5de6acf51e234"},{"seed":5,"hash":"13740b866d6bed21b0662abbfb28cb1919a634956dd532262bb3c2a3ae2b6930"}];
it('preserves escape defaults exactly',()=>{for(const row of pins)expect(createHash('sha256').update(JSON.stringify(arenaEscape.parts!(row.seed,arenaEscape.params.parse({}),3))).digest('hex')).toBe(row.hash);});
it('changes actual pickup geometry and pursuit over three waves',()=>{
const base=arenaEscape.parts!(1,arenaEscape.params.parse({chasers:1,items:8,waves:4}),3);
const tuned=arenaEscape.parts!(1,arenaEscape.params.parse({chasers:1,items:8,waves:4,itemSizePct:125,pursuitCeiling:107}),3);
let pickups=0;for(let i=0;i<base.level.bodies.length;i++)if(base.level.bodies[i]!.role==='collectible'){pickups++;expect(tuned.level.bodies[i]!.w).toBe(Math.round(base.level.bodies[i]!.w*1.25));}expect(pickups).toBeGreaterThan(0);
const chase=chaseParams.parse(tuned.control.params.chase),state=new Int32Array(100),speeds=[];for(let wave=0;wave<3;wave++){state[HEADER.counters+COUNTER.ammo]=wave;speeds.push(chaseSpeedOf(chase,state));}expect(speeds[1]!).toBeGreaterThan(speeds[0]!);expect(speeds[2]!).toBeGreaterThan(speeds[1]!);expect(speeds[2]).toBe(107);
});
it('validates the same escape bounds in recipes and runtime',()=>{const cell=liveCells().find(c=>c.id==='arena.escape+collect')!;for(const params of [{pursuitCeiling:89},{pursuitCeiling:141},{itemSizePct:99},{itemSizePct:151}]){expect(readRecipeContent(cell,{params}).ok).toBe(false);expect(arenaEscape.params.safeParse(params).success).toBe(false);}expect(readRecipeContent(cell,{params:{pursuitCeiling:107,itemSizePct:125}}).ok).toBe(true);});
