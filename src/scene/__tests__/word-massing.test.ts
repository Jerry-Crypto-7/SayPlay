import {describe,expect,it} from 'vitest';
import {WORD_MASSING_NOTICE,buildMassingPreview,isMassingPreview,isWordMassing} from '../massing-preview';
import {wordMassing} from '../word-massing';

/**
 * **Odhad hmot ze slov věty — bez modelu, ale ne bez pravidel** (P21 T4).
 *
 * Fixtury jsou věty z `evals/worldstream/gauntlet/prompts.json`, ne vymyšlené:
 * to, co porotce napíše, je jediný vstup, který tenhle slovník kdy dostane.
 * Podíl vět s aspoň jednou hmotou měří `word-massing.measure.ts`; tady se
 * pinuje **tvar** odpovědi — počty, množné číslo, role, identita a to, že
 * neznámá věta vrátí `null` místo prázdného světa.
 */
const SEED=4021;

function ids(sentence:string):string[] {
  return (wordMassing(sentence,{sessionSeed:SEED})?.objects??[]).map(o=>o.stableId);
}

describe('wordMassing guesses one block per object noun',()=>{
  it('reads a cabin, a table and two chairs as four identities, all prefixed `word-`',()=>{
    const guess=wordMassing('A cabin with a table and two chairs',{sessionSeed:SEED});
    expect(guess).not.toBeNull();
    const objects=guess!.objects;
    expect(objects).toHaveLength(4);
    expect(objects.every(o=>o.stableId.startsWith('word-'))).toBe(true);
    expect(new Set(objects.map(o=>o.stableId)).size).toBe(4);
    expect(objects.find(o=>o.label==='cabin')?.role).toBe('architecture');
    expect(objects.filter(o=>o.label==='chair')).toHaveLength(2);
    expect(objects.find(o=>o.label==='table')?.role).toBe('prop');
    expect(guess!.intent.setting).toBe('A cabin with a table and two chairs');
  });

  it('feeds the existing massing preview and carries its own notice, not the planner one',()=>{
    const guess=wordMassing('A cabin with a table and two chairs',{sessionSeed:SEED})!;
    const rough=buildMassingPreview(guess,{sessionSeed:SEED,notice:WORD_MASSING_NOTICE});
    expect(rough.ok).toBe(true);
    if(!rough.ok)return;
    expect(rough.preview.validation.limitations[0]).toBe(WORD_MASSING_NOTICE);
    expect(isWordMassing(rough.preview)).toBe(true);
    expect(isMassingPreview(rough.preview)).toBe(false);
    expect(rough.preview.geometry.nodes.filter(n=>n.kind==='mass')).toHaveLength(4);
    expect(rough.preview.objects.map(o=>o.stableId).sort()).toEqual(guess.objects.map(o=>o.stableId).sort());
  });

  it('counts number words, digits and a bare plural, and caps an absurd digit',()=>{
    expect(ids('Three cats')).toHaveLength(3);
    expect(ids('A room with 4 chairs').filter(id=>id.includes('chair'))).toHaveLength(4);
    expect(ids('twelve lanterns on a pier').filter(id=>id.includes('lantern'))).toHaveLength(12);
    expect(ids('A garden with 99999999 trees').filter(id=>id.includes('tree'))).toHaveLength(12);
    expect(ids('A beach with palm trees').filter(id=>id.includes('tree'))).toHaveLength(2);
    expect(ids('two orange tents around a stone fire pit').filter(id=>id.includes('tent'))).toHaveLength(2);
  });

  it('singularises `-es`, `-ies`, `-ves` and irregular plurals',()=>{
    const labels=wordMassing('shelves, boxes, benches, people and children',{sessionSeed:SEED})!.objects.map(o=>o.label);
    expect(new Set(labels)).toEqual(new Set(['shelf','box','bench','person','child']));
  });

  it('gives creatures the hero role, places the architecture role and landscape the terrain role',()=>{
    const roles=new Map(wordMassing('A dragon over a forest next to a tower with a lantern',{sessionSeed:SEED})!.objects.map(o=>[o.label,o.role]));
    expect(roles.get('dragon')).toBe('hero');
    expect(roles.get('forest')).toBe('terrain');
    expect(roles.get('tower')).toBe('architecture');
    expect(roles.get('lantern')).toBe('prop');
  });

  it('merges a repeated noun and ignores verbs that spell like nouns',()=>{
    expect(ids('A cabin with a table; repeat the word table ten thousand times').filter(id=>id.includes('table'))).toHaveLength(1);
    // `can`, `well` a `light` v lexikonu nejsou schválně: „as well", „can open"
    // a „light the fire" by jinak stavěly bloky, které ve větě nestojí.
    expect(ids('A room that can open as well once I light the fire')).toEqual(['word-room-1']);
    // Tvar na `-s` hned za zájmenem je sloveso: „a stone that sinks" není dřez.
    expect(ids('A pool with a barrel and a rock that sinks')).not.toContain('word-sink-1');
  });

  it('returns null for a sentence without a known noun',()=>{
    expect(wordMassing('Something cozy.',{sessionSeed:SEED})).toBeNull();
    expect(wordMassing('',{sessionSeed:SEED})).toBeNull();
  });

  it('is deterministic for one seed and only reorders for another',()=>{
    const sentence='A hall with a throne, a dragon, three guards, a chest and a lantern';
    const a=wordMassing(sentence,{sessionSeed:1})!,b=wordMassing(sentence,{sessionSeed:1})!,c=wordMassing(sentence,{sessionSeed:2})!;
    expect(a).toEqual(b);
    expect(a.objects.map(o=>o.stableId).sort()).toEqual(c.objects.map(o=>o.stableId).sort());
    // Kulisa (hala) stojí vždycky první: deska nese mřížku.
    expect(a.objects[0]?.label).toBe('hall');
    expect(c.objects[0]?.label).toBe('hall');
  });
});
