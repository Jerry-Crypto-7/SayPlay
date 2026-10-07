import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { voyageLand, landControl, landGravityAt } from '../pieces/steer';
import { shooterRange } from '../pieces/shooter';
import { arenaCollect, chaseParams, chaseSpeedOf } from '../pieces/arena';
import { HEADER, COUNTER } from '../contract';
import { readRecipeContent } from '../../director/read';
import { liveCells } from '../../compose/allowed';
const pins = [
  {
    "seed": 1,
    "land": "dd0ec4dd89195cbcf5c59c5f39c1905ce05b7a708e8bd63575dcaa26aaf6d0da",
    "shooter": "d1d4b2bfd6d19c2b3570cf153097496fb03d33b03c6b6457fb9fb7c0d1a3529b",
    "arena": "abb738adb377315d6db701b687ac815cc1511c3919ac4324be357d2a9e5397d2"
  },
  {
    "seed": 2,
    "land": "7eb1d46084ca779f7e3eb56cf92cf8dd3789b3a5975ae138ca9dc420ddb4d273",
    "shooter": "443263e68ec4d57ada06e2c8e02a40da9591eaf3edc9afe58d2e5475d3e2eb44",
    "arena": "dd6d80ac787e3797ab24e54bd10d3f7f5f0456078d6e508f42bccd3cecec443e"
  },
  {
    "seed": 3,
    "land": "437736495621e3c69e77f895437951aba4c528a20c91f434642d13bf7c563354",
    "shooter": "55c06da60768c9d1e9db1c24e8de04802ecb6f4c7545d6c96cb6197c19fe65df",
    "arena": "16695fe3bee34ed156a504a746fb6f038518e447b475786a69136dc88251b5d8"
  },
  {
    "seed": 4,
    "land": "ca0444e5af8bab03677fe1a87fbef70e13e6ac240533d41bc130759a5fd323a8",
    "shooter": "9faa34d60ed872f71378c9ff9b4d94267ae7a6578bdd9cffc734567941e1c760",
    "arena": "7579b43439259e9fa18d12a063f756fe869d10f888f8492f7a0760e385b5e62b"
  },
  {
    "seed": 5,
    "land": "3d53177966f7117ddc374642f96695eb5590e0eec9874f3c8687e95d509b5f8a",
    "shooter": "7faa17005ecef1367f8a883fa300098b26fbaf36918217524fbcc28c467b735d",
    "arena": "3aff3aca9982466f7fd4b4c77edce516f7e2d23c032ca95b51bef3cc9ca40399"
  }
];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
it('keeps the exact legacy outputs when optional settings are absent', () => {
 for (const row of pins) {
  expect(hash(voyageLand.parts!(row.seed, voyageLand.params.parse({}), 3))).toBe(row.land);
  expect(hash(shooterRange.generate(row.seed, shooterRange.params.parse({ waves: 6, rise: 4 })))).toBe(row.shooter);
  expect(hash(arenaCollect.parts!(row.seed, arenaCollect.params.parse({ items: 10, waves: 4 }), 3))).toBe(row.arena);
 }
});
it('raises actual landing acceleration over three altitude bands', () => {
 const progression = { entryHeight: 60000, gravityRisePct: 1 };
 expect([60000, 39000, 19000].map(y => landGravityAt(1000, y, progression))).toEqual([1000, 1010, 1020]);
 const descent = (y: number) => { const craft = {x:0,y,vx:0,vy:0,tilt:0}; for(let tick=0;tick<100;tick++) landControl(craft,{buttons:0,axis:0},1000,tick,progression); return craft.vy; };
 expect(descent(19000)).toBeLessThan(descent(39000)); expect(descent(39000)).toBeLessThan(descent(60000));
});
it('uses real target widths, pickup bodies and progressively faster pursuers', () => {
 const original=shooterRange.generate(1,shooterRange.params.parse({moving:false,waves:6,rise:4}));
 const narrow=shooterRange.generate(1,shooterRange.params.parse({moving:false,waves:6,rise:4,targetWidthPct:30}));
 for(let i=2;i<original.bodies.length;i++) expect(narrow.bodies[i]!.w).toBe(Math.round(original.bodies[i]!.w*.3));
 const base=arenaCollect.parts!(1,arenaCollect.params.parse({items:8,waves:4}),3);
 const tuned=arenaCollect.parts!(1,arenaCollect.params.parse({items:8,waves:4,itemSizePct:125,pursuitCeiling:115}),3);
 for(let i=0;i<base.level.bodies.length;i++) if(base.level.bodies[i]!.role==='collectible') expect(tuned.level.bodies[i]!.w).toBe(Math.round(base.level.bodies[i]!.w*1.25));
 const chase=chaseParams.parse(tuned.control.params.chase); const state=new Int32Array(100); const speeds=[];
 for(let wave=0;wave<3;wave++){state[HEADER.counters+COUNTER.ammo]=wave;speeds.push(chaseSpeedOf(chase,state));}
 expect(speeds[1]!).toBeGreaterThan(speeds[0]!);expect(speeds[2]!).toBeGreaterThan(speeds[1]!);expect(speeds[2]).toBe(115);
});
it('rejects recipe settings beyond runtime bounds',()=>{
 for(const [id,good,bad]of [
 ['voyage.land',{touchdownSpeed:19,gravityRisePct:1},{touchdownSpeed:14}],
 ['voyage.land',{touchdownSpeed:19,gravityRisePct:1},{gravityRisePct:31}],
 ['shooter.default',{targetWidthPct:30,movingTargets:0},{targetWidthPct:24}],
 ['arena.collect',{pursuitCeiling:115,itemSizePct:125},{itemSizePct:151}],
 ['arena.collect',{pursuitCeiling:115,itemSizePct:125},{pursuitCeiling:141}],
 ]as const){const cell=liveCells().find(cell=>cell.id===id)!;expect(readRecipeContent(cell,{params:good}).ok).toBe(true);expect(readRecipeContent(cell,{params:bad}).ok).toBe(false);}
});
