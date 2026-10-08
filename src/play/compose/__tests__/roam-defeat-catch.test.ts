import { beforeAll, describe, expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { IntentTriple } from '@/play/intent/contract';

// „Porazit N cílů“ bez řečeného pohybu je souboj v aréně (`arena.fight`), ne sbírání,
// a honička bez jmenované kořisti je chytání (kořist dá prostředí) – obojí se musí
// zahrát (svědek), nestačí to přiznat. Šablony s vlastními slovy.
beforeAll(async () => { await loadRapier(); });

const TARGETS = [
  { plural: 'goblins', one: 'goblin', place: 'castle' },
  { plural: 'scarecrows', one: 'scarecrow', place: 'barn' },
  { plural: 'jelly monsters', one: 'monster', place: 'swamp' },
] as const;
const CROWDS = [
  { place: 'busy harbor', crowd: 'tourists' },
  { place: 'sleepy village', crowd: 'farmers' },
  { place: 'crowded plaza', crowd: 'pilgrims' },
] as const;
const triple = (actor: string, verb: string, object: string | null): IntentTriple => ({ actor, verb, object });
const CASES = [
  ...TARGETS.flatMap((target) => [
    { sentence: `Defeat three ${target.plural} in the ${target.place}.`, triple: triple('hero', 'defeat', target.one) },
    { sentence: `Knock out five ${target.plural} in the ${target.place}.`, triple: triple('hero', 'defeat', target.one) },
    { sentence: `Destroy the four ${target.plural} in the ${target.place}.`, triple: triple('hero', 'defeat', target.one) },
    { sentence: `A knight defeats six ${target.plural} in the ${target.place}.`, triple: triple('knight', 'defeat', target.one) },
  ]),
  ...CROWDS.map((crowd) => ({ sentence: `A ${crowd.place} full of ${crowd.crowd} and a three-minute chase.`, triple: triple('hero', 'catch', null) })),
  // Jmenovaná kořist zůstává kořistí – výchozí nepřítel prostředí ji nepředběhne.
  { sentence: 'A dog chases a squirrel in the park.', triple: triple('dog', 'catch', 'squirrel') },
];

describe('defeating counted targets plays a fight, an unnamed chase plays a catch', () => {
  it.each(CASES)('$sentence', ({ sentence, triple: expected }) => {
    vi.stubEnv('PLAY_READER', 'off');
    try {
      const { spec, composition } = draftGameSpecWithMeta(sentence, 1);
      expect(composition?.unmet ?? [], `${expected.verb} is played, not admitted`).toEqual([]);
      const made = arcadeWorldOf(spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const witnesses = verifyArcade(made.world, undefined, made.roleBindings).witnesses;
      expect(witnesses.some((witness) => matchesWitness(expected, witness)), `${expected.actor}/${expected.verb}/${expected.object}`).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);
});
