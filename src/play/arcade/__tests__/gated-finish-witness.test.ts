import { beforeAll, describe, expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';
import { draftGameSpecWithMeta } from '@/play/draft';

// Složená hra (plošinovka + pojmenovaná hrozba jako díl) zamyká nativní výhru do keeperu
// `assembly_gate_*`; dotek cíle je pořád `reach`, ne jen přežití. Šablony s vlastními slovy.
beforeAll(async () => { await loadRapier(); });

const CASES = ['lava pool', 'acid pool'].flatMap((hazard) => ['gate', 'tower'].flatMap((goal) => [
  { sentence: `Hop between floating platforms over a ${hazard} to reach the far ${goal}.`, goal, hazard: hazard.split(' ')[0]! },
  { sentence: `Jump across broken bridges over a ${hazard} to reach the old ${goal}.`, goal, hazard: hazard.split(' ')[0]! },
]));

describe('a gated native finish is still a reach', () => {
  it.each(CASES)('$sentence', ({ sentence, goal, hazard }) => {
    vi.stubEnv('PLAY_READER', 'off');
    try {
      const { spec } = draftGameSpecWithMeta(sentence, 1);
      expect(spec.assemblyParts?.some((part) => part.kind === 'hazard'), 'the hazard is a part').toBe(true);
      const made = arcadeWorldOf(spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const witnesses = verifyArcade(made.world, undefined, made.roleBindings).witnesses;
      expect(witnesses.some((witness) => matchesWitness({ actor: 'hero', verb: 'reach', object: goal }, witness)), `reach ${goal}`).toBe(true);
      expect(witnesses.some((witness) => matchesWitness({ actor: hazard, verb: 'hazard', object: 'hero' }, witness)), `${hazard} hazard`).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);
});
