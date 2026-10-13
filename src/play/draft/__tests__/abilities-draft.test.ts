/**
 * P46A T8: rychlá verze vybere akce hrdiny ze sloves věty – nejvýš dvě, v pořadí
 * věty a jen ty, které ovládání bere. Věty majitele z 12. 10. (spec P46, tabulka
 * Fakta) a „fight“ za pohybu, který už nevynutí souboj na místě. Hra s akcí se
 * musí dát publikovat: robot vyhraje a sloveso akce prokáže.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { abilityIdsOf } from '@/play/arcade/abilities/state';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { BUTTON, underlyingRule } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpec } from '@/play/draft';
import { abilitiesFor, nearestControl, pickControl, saidAbilities } from '@/play/draft/controls';

const OWNER = [
  { text: 'A rabbit steals carrots and runs from a fox', control: 'runner', abilities: ['grab'], addons: ['chaser'] },
  { text: 'Amanita mushrooms fight against bulls, flee from them, and shoot them.', control: 'runner', abilities: ['strike', 'shoot'] },
  { text: 'Racing car escaping and shooting enemies', control: 'steer', abilities: ['shoot'], addons: ['shoot', 'chaser'] },
  { text: 'racing car escapes police and shoots enemies', control: 'steer', abilities: ['shoot'], addons: ['shoot', 'chaser'] },
  { text: 'Hamster escapes a supermarket Roomba', control: 'runner' },
  { text: 'Jumping arcade game in the forest', control: 'platform' },
  { text: 'A ninja frog jumps over logs', control: 'platform' },
  { text: 'A bee collects pollen in a garden', control: 'move_free' },
] as const;

/** Hry generátoru režimu (P46A T10): aréna útěk/sběr a bludiště akce berou, souboj ne. */
const GENERATED = [
  { text: 'A raccoon grabs pizza slices while dodging trash trucks', control: 'move_free', abilities: ['grab', 'dash'] },
  { text: 'A squirrel snatches acorns from crows in a windy forest', control: 'move_free', abilities: ['grab'] },
  { text: 'A cat burglar sneaks through a museum and steals diamonds', control: 'walker', abilities: ['grab'] },
  { text: 'a wizard defends a crystal tower from flying skeletons', control: 'move_free' },
] as const;

describe('abilities from the sentence verbs (P46A T8)', () => {
  for (const line of [...OWNER, ...GENERATED]) {
    it(`${line.text} → ${line.control} ${'abilities' in line ? line.abilities.join('+') : 'without abilities'}`, async () => {
      const spec = draftGameSpec(line.text);
      expect(spec.control).toBe(line.control);
      expect(spec.abilities).toEqual('abilities' in line ? line.abilities : undefined);
      if ('addons' in line) expect(spec.addons).toEqual(line.addons);
      if (!('abilities' in line)) return;
      // Publikace zkouší odvozená semínka; hra s akcí musí projít aspoň na jednom.
      await preloadPhysics(spec, loadRapier);
      const failures: string[] = [];
      const playable = derivedSeeds(seedFrom(line.text)).some((seed) => {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) return failures.push(...made.issues) < 0;
        const verdict = verifyArcade(made.world, undefined, made.roleBindings);
        failures.push(...verdict.failures);
        return verdict.publishEligible;
      });
      expect(playable, failures.join('; ')).toBe(true);
    }, 180_000);
  }

  it('drops abilities the bot cannot prove instead of returning an unverified game', async () => {
    // Řízení `+shoot` s dash+shoot robot zatím nevyhraje (R4): návrh musí být ta hra, kterou compose ověřil.
    const spec = draftGameSpec('A motorbike dodges cars on a highway and blasts drones');
    await preloadPhysics(spec, loadRapier);
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.publishEligible, verdict.failures.join('; ')).toBe(true);
  }, 180_000);

  it('names the buttons in the hint when it fits', () => {
    expect(draftGameSpec('A rabbit steals carrots and runs from a fox').tutorial.controlsHint).toMatch(/ J to grab\.$/);
    // Díl souboje bije i úder akce, takže nápověda k Attack ustoupí.
    expect(draftGameSpec('A knight runs through a castle and punches goblins').tutorial.controlsHint).toBe('Arrows dodge. Space jumps. J to strike.');
  });

  it('lets the strike button hit a fight part and shows it under the part wrapper', async () => {
    const spec = draftGameSpec('A knight runs through a castle and punches goblins');
    await preloadPhysics(spec, loadRapier);
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    // J ve hře s akcemi patří akci A – díl souboje ji musí brát jako ATTACK.
    const fights = made.world.rules.map(underlyingRule).filter((rule) => rule.id === 'assembly_part' && (rule.params.part as { kind: string }).kind === 'fight');
    expect(fights.length).toBeGreaterThan(0);
    for (const rule of fights) expect(rule.params.strike).toBe(BUTTON.ACTION_A);
    expect(abilityIdsOf(made.world.control)).toEqual(['strike']);
  });

  it('keeps sentence order, at most two, and only what the control takes', () => {
    expect(saidAbilities('a ninja dashes over rooftops and kicks robot guards')).toEqual(['dash', 'strike']);
    expect(abilitiesFor('the hero shoots, punches, steals and dodges', 'runner')).toEqual(['shoot', 'strike']);
    expect(abilitiesFor('a fox steals eggs and punches a bear', 'duel')).toEqual([]);
  });

  it('does not hear an action in being hit, collecting or catching', () => {
    expect(saidAbilities('a ball that gets hit by falling rocks')).toEqual([]);
    expect(saidAbilities('run and avoid getting hit')).toEqual([]);
    expect(saidAbilities('collect coins and catch fish')).toEqual([]);
    expect(saidAbilities('a photo shoot under shooting stars')).toEqual([]);
  });

  it('keeps a duel when the fight stays in place, not when the hero travels', () => {
    expect(draftGameSpec('boxing a kangaroo in the australian outback').control).toBe('duel');
    expect(draftGameSpec('A knight duels a dragon').control).toBe('duel');
    expect(pickControl('two samurai fight with swords')?.control).toBe('duel');
    expect(pickControl('amanita mushrooms fight against bulls, flee from them, and shoot them.')?.control).not.toBe('duel');
    expect(nearestControl('a knight fights a dragon').choice.control).toBe('duel');
    expect(nearestControl('a knight fights a dragon and flees').choice.control).not.toBe('duel');
  });
});
