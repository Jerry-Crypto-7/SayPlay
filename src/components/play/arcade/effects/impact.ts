import { type ArcadeEffect, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, ROLE, RUN_STATE, bodyBase, bodyHp } from '@/play/arcade/contract';
const alive = (s:Int32Array,i:number) => !!(s[bodyBase(i)+BODY.flags]! & FLAG.alive);
/** Same swept AABB predicate as the projectile kernel, not a proximity guess. */
function swept(s:Int32Array, a:number,b:number):boolean {
  const x=bodyBase(a),y=bodyBase(b),vx=s[x+BODY.vx]!,vy=s[x+BODY.vy]!,vz=s[x+BODY.vz]!,ay=s[x+BODY.y]!;
  return Math.abs(2*s[x+BODY.x]!-vx-2*s[y+BODY.x]!) < s[x+BODY.w]!+Math.abs(vx)+s[y+BODY.w]!
    && Math.abs(2*s[x+BODY.z]!-vz-2*s[y+BODY.z]!) < s[x+BODY.d]!+Math.abs(vz)+s[y+BODY.d]!
    && Math.min(ay,ay-vy)<s[y+BODY.y]!+s[y+BODY.h]! && s[y+BODY.y]!<Math.max(ay,ay-vy)+s[x+BODY.h]!;
}
/** Health/HP really dropped, or a projectile collided with a removed target. No generic score/death inference. */
export function actualHitBodies(effects:readonly ArcadeEffect[], before:Int32Array, after:Int32Array, world?:Pick<ArcadeWorld,'rules'>):ReadonlySet<number> {
  const hits=new Set<number>(), player=after[HEADER.player]!, count=after[HEADER.bodyCount]!;
  if(effects.some(e=>e.kind==='damage' && e.amount>0) && after[HEADER.counters+COUNTER.health]! < before[HEADER.counters+COUNTER.health]!) hits.add(player);
  for(const e of effects) if(e.kind==='hit' && e.amount>0 && e.body>=0 && e.body<count && alive(before,e.body) && (bodyHp(after,e.body)<bodyHp(before,e.body) || !alive(after,e.body))) hits.add(e.body);
  // A no-lives collision ends the run instead of decrementing health. Require actual overlap with a harmful rule role.
  if(world && before[HEADER.runState]===RUN_STATE.running && after[HEADER.runState]===RUN_STATE.lost && effects.some(e=>e.kind==='lose')) {
    const roles=new Set<number>(world.rules.filter(r=>r.id==='hit' && r.params.effect==='lose').map(r=>ROLE[r.params.role as keyof typeof ROLE]));
    const p=bodyBase(player);
    for(let i=0;i<count;i++) {
      const b=bodyBase(i);
      if(!alive(before,i) || !roles.has(after[b+BODY.role]!)) continue;
      if(Math.abs(after[p+BODY.x]!-after[b+BODY.x]!)*2<after[p+BODY.w]!+after[b+BODY.w]! && Math.abs(after[p+BODY.z]!-after[b+BODY.z]!)*2<after[p+BODY.d]!+after[b+BODY.d]! && after[p+BODY.y]!<after[b+BODY.y]!+after[b+BODY.h]! && after[b+BODY.y]!<after[p+BODY.y]!+after[p+BODY.h]!) hits.add(player);
    }
  }
  const shots=world?.rules.filter(r=>r.id==='shot_hit'||r.id==='glide_shot_hit') ?? [];
  if(shots.length===0) return hits;
  const removed=new Set(effects.flatMap(e=>e.kind==='despawn'?[e.body]:[]));
  for(let projectile=0;projectile<count;projectile++) {
    const p=bodyBase(projectile);
    if(before[p+BODY.role]!==ROLE.projectile || !alive(before,projectile) || alive(after,projectile)) continue;
    // First collision by index, including intervening walls, as in the kernel.
    for(let target=0;target<count;target++) {
      if(target===player || target===projectile || !alive(before,target)) continue;
      const b=bodyBase(target),role=after[b+BODY.role]!;
      if(role===ROLE.projectile || !(role===ROLE.enemy || role===ROLE.target || (after[b+BODY.flags]!&FLAG.solid)) || !swept(after,projectile,target)) continue;
      const allowed=shots.some(rule=>rule.id==='shot_hit' || !(after[b+BODY.flags]!&FLAG.kinematic));
      if(allowed && (role===ROLE.enemy||role===ROLE.target) && removed.has(target) && !alive(after,target)) hits.add(target);
      break;
    }
  }
  return hits;
}
