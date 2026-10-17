import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {glideCourse,glideCourseParams} from '../pieces/glide';
import {walkerParamsSchema,walkerLabyrinth,walkerStealth,walkerEscape,WALKER_CELL} from '../pieces/walker';
import {glideSpecParamsSchema,walkerSpecParamsSchema} from '../../spec';
import {nativeRecipeParams} from '../../director/answer-schema';
import {assemblyOfCell,liveCells} from '../../compose/allowed';
import {compileRecipe} from '../../compose/compile';
import {arcadeWorldOf} from '../compile';
import {ARCADE_LIBRARY} from '../library';
import {instantiate,loadProgram,step} from '../kernel';
import {BODY,HEADER,AXIS_MAX,bodyBase} from '../contract';
const defaultHashes = [{"id":"glide","mode":"reach","seed":1,"hash":"aefa272348f49c68a2898d64bd9a0bd5483919633c6e03f3be2fd74e78221546"},{"id":"glide","mode":"reach","seed":2,"hash":"c36d122373427104c5738e42b37e1473bcba811693b0762208d83e1be1a79a9a"},{"id":"glide","mode":"reach","seed":3,"hash":"fbdadfa5a7b86fb890aa315af9f83db64518765b03dcc635e19b1cae926f7762"},{"id":"glide","mode":"reach","seed":4,"hash":"7044af35b80db5dd91a57934880190541eefa3837ca0a94ea18f4763b254dcec"},{"id":"glide","mode":"reach","seed":5,"hash":"b9b457a2126889129f7454950d3009c5ceb4e34fb2fb93124f37def6807642c5"},{"id":"glide","mode":"collect","seed":1,"hash":"aefa272348f49c68a2898d64bd9a0bd5483919633c6e03f3be2fd74e78221546"},{"id":"glide","mode":"collect","seed":2,"hash":"c36d122373427104c5738e42b37e1473bcba811693b0762208d83e1be1a79a9a"},{"id":"glide","mode":"collect","seed":3,"hash":"fbdadfa5a7b86fb890aa315af9f83db64518765b03dcc635e19b1cae926f7762"},{"id":"glide","mode":"collect","seed":4,"hash":"7044af35b80db5dd91a57934880190541eefa3837ca0a94ea18f4763b254dcec"},{"id":"glide","mode":"collect","seed":5,"hash":"b9b457a2126889129f7454950d3009c5ceb4e34fb2fb93124f37def6807642c5"},{"id":"glide","mode":"race","seed":1,"hash":"788c7a64f2b58ab28e33b3da3ac908b08c0a2172ddf2e54eea6c4d61b532934d"},{"id":"glide","mode":"race","seed":2,"hash":"b24583e7c844737dd659d5dc66257dfcf1ae7ac4a22b0c8ba3930082f03fb851"},{"id":"glide","mode":"race","seed":3,"hash":"1fa15605997f8b2539cf4f4d442af384e467e6bf2d6141566019c4dad1ac7917"},{"id":"glide","mode":"race","seed":4,"hash":"67cc3e5fcec4cee688404b200c0d8981ac636caaf5422b355de96a33c194e710"},{"id":"glide","mode":"race","seed":5,"hash":"5088910e5adc487bf696473d59eb494236ed449f28d1d94ce38ec707e6c59267"},{"id":"glide","mode":"escape","seed":1,"hash":"c316e73b4c510effeb5f8841ca5a00dbbdc2e2e90b7edf02cb157ed6a969bafd"},{"id":"glide","mode":"escape","seed":2,"hash":"0f16a7941af599fff726345f462fbfa97c5886aa632b58125e0ff05b822c8dfb"},{"id":"glide","mode":"escape","seed":3,"hash":"96b952fc0d9effa22ef675ec8beaa6912712f8c39081c97f06bda47b98b0a421"},{"id":"glide","mode":"escape","seed":4,"hash":"c2e9c918115b187a91434f5e98f62a3e5836b712d0a588482275f4bc07784fb4"},{"id":"glide","mode":"escape","seed":5,"hash":"d3383de46962e35ebaee8bf79e6f783dd8ee4bc32096fbc5b6901b1aee858643"},{"id":"labyrinth","seed":1,"hash":"b51af3218d57cb2a9c4b9384637b65affec9821370bd88bcf773dd1c0357f23e"},{"id":"labyrinth","seed":2,"hash":"15ca5db403063ee611fdc8668b3a76b6f19b1860af98105a8d5daa75090d25b4"},{"id":"labyrinth","seed":3,"hash":"58f896bf62c19c382f3201e54971bc0064b477a51600112393dd681be3ba70e2"},{"id":"labyrinth","seed":4,"hash":"5fb8d89f2d9327bad084795b39a177a438235c945b04654ec0042f244d00f904"},{"id":"labyrinth","seed":5,"hash":"a087b42ada15d3cb5568cd5a66b39b55e87d273f680b4cff8cd1b1780f1b624c"},{"id":"stealth","seed":1,"hash":"ce3ea0405e272cbaa2d435321f91398e4906e1af137ea56e6fc4b047cb66eea3"},{"id":"stealth","seed":2,"hash":"99d6a2afd8723114b3a23d3bd65ee53916ff46c8bbd935ee94c5585c885a9015"},{"id":"stealth","seed":3,"hash":"2bfeb119a4bd9b6464676713a680502e9979084ef129056ab607cc3ef4bd1ff5"},{"id":"stealth","seed":4,"hash":"8e2de3600d4de2120ef4b326230e40d45b7b337e9de497e0d3b867a0e874c3ce"},{"id":"stealth","seed":5,"hash":"2ab124e910cac20a30f80f07970732ed088172da05dc4275a1bb7f1b97b4e96d"},{"id":"escape","seed":1,"hash":"aa955dd278a64b17b8206d4f0d7385b6ea34a9fbc2cdd54c7621f9b1fc21e24a"},{"id":"escape","seed":2,"hash":"06cccf557c16308d8fecd5978de68b884089092175eb1572974eb63516ac3b61"},{"id":"escape","seed":3,"hash":"6c1a08e3a3c4f60e598f1def53d69d0a4afe9f7af2d21eea4b460f47f5e8db41"},{"id":"escape","seed":4,"hash":"97d7f3afed7ae700e50586192c14fce1a3f19d7cf1e8d8004046e2dea9e33700"},{"id":"escape","seed":5,"hash":"cb21e165b5db7099bac02eb315f3fab00ed5edd8c40c1b5e56be5f051e8e5357"}] as const;
it('keeps every omitted-parameter default identical to the pre-tuning generated parts',()=>{
 for(const row of defaultHashes){let parts:unknown;
  if(row.id==='glide')parts=glideCourse.parts(row.seed,glideCourse.params.parse({mode:row.mode}),undefined);
  else {const generator={labyrinth:walkerLabyrinth,stealth:walkerStealth,escape:walkerEscape}[row.id];parts=generator.parts(row.seed,generator.params.parse({}),undefined);}
  expect(createHash('sha256').update(JSON.stringify(parts)).digest('hex')).toBe(row.hash);
 }
});
it('uses the same bounded tuning fields in runtime, stored spec, and director reader',()=>{
 for(const [schemas,key,min,max] of [
  [[glideCourseParams,glideSpecParamsSchema,nativeRecipeParams.glide],'clearancePermille',250,1000],
  [[glideCourseParams,glideSpecParamsSchema,nativeRecipeParams.glide],'clearanceRisePermille',0,250],
  [[walkerParamsSchema,walkerSpecParamsSchema,nativeRecipeParams.walk],'paceBudgetPct',100,180],
  [[walkerParamsSchema,walkerSpecParamsSchema,nativeRecipeParams.walk],'corridorRisePermille',0,200],
 ] as const)for(const schema of schemas){for(const value of [min,max])expect(schema.safeParse({[key]:value}).success).toBe(true);for(const value of [min-1,max+1, min+0.5])expect(schema.safeParse({[key]:value}).success).toBe(false);}
});
it('narrows real ring and reef gaps across three sections',()=>{
 const level=glideCourse.generate(1,glideCourseParams.parse({clearancePermille:275,clearanceRisePermille:10}));
 const widths=level.bodies.filter(b=>b.kind==='glide-ring').map(b=>b.w);
 expect([...new Set(widths)]).toEqual([1026,1008,990]);
 for(let i=0;i<level.bodies.length;i++){const ring=level.bodies[i];if(ring.kind!=='glide-ring')continue;const left=level.bodies[i+1],right=level.bodies[i+2];expect(Math.abs(right.x-right.w/2-(left.x+left.w/2)-ring.w)).toBeLessThanOrEqual(1); /* Existing integer frame-centre rounding. */}
});
it('preserves cell tuning when named content replaces the reference cast',()=>{
 for(const cell of liveCells().filter(c=>c.assembly==='native'&&['walk','glide'].includes(c.recipe.move))){const {params:_params,...content}=cell.preset;const spec=compileRecipe(assemblyOfCell(cell,{...content,hero:'fox'}));expect(spec.controlParams).toMatchObject(cell.recipe.move==='walk'?{paceBudgetPct:100,corridorRisePermille:200}:{clearancePermille:275,clearanceRisePermille:10});}
});
it('later solid corridor walls physically block the same input sooner',()=>{
 // Bez značky nové hry (P51 T3): pravidlo `pacing` obalí ovládání a `control.params` by mapu neneslo.
 const cell=liveCells().find(c=>c.id==='walk.reach')!;const {segments:_segments,...params}=compileRecipe(assemblyOfCell(cell)).controlParams as Record<string,unknown>;const spec={...compileRecipe(assemblyOfCell(cell)),controlParams:params as ReturnType<typeof compileRecipe>['controlParams']};const made=arcadeWorldOf(spec,1);if(!made.ok)throw Error('build');
 const original=arcadeWorldOf({...spec,controlParams:{...spec.controlParams,corridorRisePermille:undefined}},1);if(!original.ok)throw Error('baseline build');
 const map=made.world.control.params as {size:number;open:number[]};let wall=-1,cellX=0,cellZ=0,sign=0;
 for(let i=0;i<made.world.initial[HEADER.bodyCount];i++){
  const b=bodyBase(i),w=made.world.initial[b+BODY.w];if(w!==4800)continue;
  const x=made.world.initial[b+BODY.x]/WALKER_CELL,z=made.world.initial[b+BODY.z]/WALKER_CELL;
  for(const side of [-1,1])if(map.open.includes(z*map.size+x+side)){wall=i;cellX=(x+side)*WALKER_CELL;cellZ=z*WALKER_CELL;sign=-side;break;}
  if(wall>=0)break;
 }
 expect(wall).toBeGreaterThanOrEqual(0);
 const travel=(world:typeof made.world)=>{const state=instantiate(world),b=bodyBase(state[HEADER.player]);state[b+BODY.x]=cellX;state[b+BODY.z]=cellZ;const program=loadProgram(world,ARCADE_LIBRARY);for(let tick=0;tick<60;tick++)step(state,{axis:sign*AXIS_MAX,buttons:0},program);return (state[b+BODY.x]-cellX)*sign;};
 const before=travel(original.world),after=travel(made.world);expect(before-after).toBe(400);expect(after).toBeGreaterThan(0);
});
