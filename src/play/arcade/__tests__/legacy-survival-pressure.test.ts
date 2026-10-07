import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {arenaEscape} from '../pieces/arena';
import {arenaWaves} from '../pieces/waves';
import {HEADER,COUNTER,BODY,FLAG,ROLE,NO_INPUT,bodyBase} from '../contract';
import {buildWorld,instantiate,loadProgram,step} from '../kernel';
import {ARCADE_LIBRARY} from '../library';
import {readRecipeContent} from '../../director/read';
import {liveCells} from '../../compose/allowed';
const pins=[{"seed":1,"params":{},"hash":"62d6df719744f7bc7a87effd05af55f3a02ea62679ee421890c1a8d7e75ab1eb"},{"seed":1,"params":{"waves":3},"hash":"4b6e6554b7ec2bf4cc866e50846ed8d1b7456b1deb8e31541371f97b7c1deab0"},{"seed":2,"params":{},"hash":"b7c470e541f6276d45541f2c8e91d60ff98831477ba847dd4e9fb4be18facaa6"},{"seed":2,"params":{"waves":3},"hash":"3d7fcb95f324b6e20530d3725641a2fe21c4c5112e7c2ff3324648e1734643e0"},{"seed":3,"params":{},"hash":"95d3016bd1b42ee2f460715134a45697116ea4158586325492a6ec9951a2f807"},{"seed":3,"params":{"waves":3},"hash":"e990e31c97b06d449a3c07d0950d04c568a11a234d59d1a0140245e6fa6507cf"},{"seed":4,"params":{},"hash":"c9df5ac055243d411555f77311012c386fa851d9c2e927101bd5de6acf51e234"},{"seed":4,"params":{"waves":3},"hash":"8b1b0e207cac2b6c78ea0f9f923f89bd77ae3a0284f059a5ec9bd8b10287ced2"},{"seed":5,"params":{},"hash":"13740b866d6bed21b0662abbfb28cb1919a634956dd532262bb3c2a3ae2b6930"},{"seed":5,"params":{"waves":3},"hash":"23f7ca666ec26d3a26e1d9f5794050fe59c04afc899dc68fa9517d8d1abb0238"}];
it('preserves both original escape variants when pressure is omitted',()=>{for(const row of pins)expect(createHash('sha256').update(JSON.stringify(arenaEscape.parts!(row.seed,arenaEscape.params.parse(row.params),3))).digest('hex')).toBe(row.hash);});
it('spawns real reinforcements progressively closer on the seeded entry segment',()=>{
const state=new Int32Array(300);state[HEADER.bodyCount]=2;state[HEADER.tick]=10000;const p=bodyBase(0);state[p+BODY.x]=1000;state[p+BODY.z]=-2000;
const params=arenaWaves.params.parse({until:'ticks',chaser:1,spots:[18000,18000,-18000,18000],entryDistance:6000,waves:[{at:1,chasers:1},{at:2,chasers:1}]});
for(const [wave,distance]of[[0,8000],[1,6000]]as const){state[HEADER.counters+COUNTER.ammo]=wave;const effects=arenaWaves.fire({state,player:0,other:-1,source:-1,input:NO_INPUT},params);const spawn=effects.find(e=>e.kind==='spawn');expect(spawn).toBeDefined();if(spawn?.kind!=='spawn')throw Error('missing reinforcement');expect(spawn.template).toBe(1);expect(Math.max(Math.abs(spawn.x-1000),Math.abs(spawn.z+2000))).toBe(distance);expect(spawn.x).toBeLessThan(1000);expect(spawn.z).toBeGreaterThan(-2000);}
});
it('applies chase lead to actual pursuit motion',()=>{
const run=(lead:number)=>{const parts=arenaEscape.parts!(1,arenaEscape.params.parse({chaseLead:lead,chasers:2}),3);const built=buildWorld({seed:1,level:parts.level,control:parts.control,rules:parts.rules,bot:parts.bot,health:3},ARCADE_LIBRARY);if(!built.ok)throw Error(built.issues.join(';'));const state=instantiate(built.world),program=loadProgram(built.world,ARCADE_LIBRARY);for(let tick=0;tick<360;tick++)step(state,{buttons:0,axis:tick<180?1:500},program);const positions=[];for(let i=0;i<state[HEADER.bodyCount]!;i++){const b=bodyBase(i);if(state[b+BODY.role]===ROLE.chaser&&(state[b+BODY.flags]!&FLAG.alive)!==0)positions.push([state[b+BODY.x],state[b+BODY.z]]);}expect(positions.length).toBeGreaterThan(0);return positions;};expect(run(29)).not.toEqual(run(0));
});
it('validates matching recipe/runtime bounds and requires reinforcement waves',()=>{
const cell=liveCells().find(c=>c.id==='arena.escape')!;for(const params of[{entryDistance:5999},{entryDistance:20001},{chaseLead:-1},{chaseLead:121}]){expect(readRecipeContent(cell,{params}).ok).toBe(false);expect(arenaEscape.params.safeParse({...params,waves:3}).success).toBe(false);}expect(readRecipeContent(cell,{params:{entryDistance:6000,chaseLead:29}}).ok).toBe(true);expect(arenaEscape.params.safeParse({entryDistance:6000}).success).toBe(false);expect(arenaEscape.params.safeParse({entryDistance:6000,chaseLead:29,waves:3}).success).toBe(true);
});
