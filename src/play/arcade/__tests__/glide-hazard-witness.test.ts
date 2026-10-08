import { expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft/draft';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { verifyArcade, runBot } from '@/play/arcade/verify';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
const cases = [
 ['ma-016','a dragon flying through the clouds collecting gems while dodging arrows','arrow','dragon'],
 ['ma-017','a fish swimming in the ocean eating smaller fish and avoiding sharks','shark','fish'],
 ['ma-033','a submarine diving deep to collect pearls while avoiding mines','mine','submarine'],
] as const;
// P42: pojmenovaná hrozba je připojený letící díl; ublíží mu pravidlo
// assembly_part toho dílu, ne nativní `hit` útesu.
it.each(cases)('%s actual attached threat diagnosis', (_id,sentence,label,hero) => {
 for (const seed of [1,2,3,4,5]) {
  const draft=draftGameSpecWithMeta(sentence,seed);
  const made=arcadeWorldOf(draft.spec,seed); if(!made.ok) throw new Error(made.issues.join(';'));
  const v=verifyArcade(made.world,undefined,made.roleBindings);
  const harmful=v.witnesses.filter(w=>w.run==='probe');
  const target=made.roleBindings.find(b=>b.label===label)!;
  expect(v.bot.outcome).toBe('won');
  expect(harmful.some(w=>w.verb==='hazard'&&w.actor.label===label&&w.object?.label===hero&&w.evidence==='moving-threat-contact')).toBe(true);
  const renamedBindings=made.roleBindings.map(b=>b.roleId===target.roleId?{...b,label:'unrelated threat'}:b);
  const renamed=runBot(made.world,undefined,{roleBindings:renamedBindings,probeBody:target.body});
  expect(renamed.witnesses.some(w=>w.verb==='hazard'&&w.actor.label===label)).toBe(false);
  expect(renamed.witnesses.some(w=>w.verb==='hazard'&&w.actor.label==='unrelated threat')).toBe(true);
  expect(made.world.rules.some(r=>r.id==='assembly_part'&&(r.params.part as {body:number}).body===target.body)).toBe(true);
  // Stejný díl, stejný pohyb a kontakt, jen bez rány: svědek nesmí vzniknout.
  const part=ARCADE_LIBRARY.rules.assembly_part!;
  const harmless={...ARCADE_LIBRARY,rules:{...ARCADE_LIBRARY.rules,assembly_part:{...part,fire:(...args:Parameters<typeof part.fire>)=>part.fire(...args).filter(e=>e.kind!=='damage'&&e.kind!=='lose')}}};
  const negative=runBot(made.world,harmless,{roleBindings:made.roleBindings,probeBody:target.body});
  expect(negative.witnesses.some(w=>w.actor.roleId===target.roleId&&['hazard','obstacle'].includes(w.verb))).toBe(false);
  expect(harmful.some(w=>w.actor.label==='unrelated threat')).toBe(false);
 }
});
