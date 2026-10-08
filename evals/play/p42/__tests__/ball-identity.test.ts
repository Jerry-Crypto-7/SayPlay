import { beforeAll, expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { BODY, HEADER, bodyBase } from '@/play/arcade/contract';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';

beforeAll(loadRapier);
// Former P41 held-out is explicitly development data in P42.
it('basketball keeps a real ball, a hoop and the named robot team', () => {
 const draft=draftGameSpecWithMeta('a basketball game against a robot team, dribble and shoot hoops',1);
 expect.soft(draft.spec.control).toBe('ball');
 expect.soft(draft.spec.controlParams?.team).toBe(true);
 expect.soft(draft.spec.roles.find(r=>r.kind==='player')?.label).not.toBe('fox');
 const made=arcadeWorldOf(draft.spec,1);
 if(!made.ok) throw new Error(made.issues.join('; '));
 const roles=made.roleBindings;
 const bodies=(kind:string)=>Array.from({length:made.world.initial[HEADER.bodyCount]!},(_,i)=>i).filter(i=>made.world.kinds[made.world.initial[bodyBase(i)+BODY.kind]!]===kind);
 expect.soft(roles.find(r=>bodies('physics-ball').includes(r.body))?.label).toMatch(/ball/);
 expect.soft(roles.find(r=>bodies('hoop').includes(r.body))?.label).toBe('hoop');
 for(const kind of ['goalkeeper','opponent-forward']) expect.soft(roles.find(r=>bodies(kind).includes(r.body))?.label).toMatch(/robot/);
 const verdict=verifyArcade(made.world,undefined,roles);
 expect.soft(verdict.publishEligible).toBe(true);
 expect.soft(verdict.witnesses.some(w=>matchesWitness({actor:'robot',verb:'rival',object:'hero'},w))).toBe(true);
});
